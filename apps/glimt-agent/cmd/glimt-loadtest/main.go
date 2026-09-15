// glimt-loadtest kjører N falske agenter mot en hub med agentens ekte
// WebSocket-klient (IMPLEMENTERINGSPLAN steg 11.4). Hver agent melder seg inn
// med dev-nøkkelen, sender snapshot hvert intervall huben ber om og stream
// når huben abonnerer, og svarer på loggstrømmer med syntetiske linjer.
// Tallene er syntetiske; det som måles er huben (RSS, CPU, ingen stream-drops).
//
//	go run ./cmd/glimt-loadtest -hub ws://localhost:5080/agent/ws -key gp_e2e -n 100 -duration 5m
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"math"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/ws"
)

// stats er tellerne som skrives ut hvert rapportintervall og til slutt.
type stats struct {
	connected atomic.Int64
	welcomes  atomic.Int64
	snapshots atomic.Int64
	streams   atomic.Int64
	dropped   atomic.Int64
	logs      atomic.Int64
}

type summary struct {
	Agents    int   `json:"agents"`
	Connected int64 `json:"connected"`
	Welcomes  int64 `json:"welcomes"`
	Snapshots int64 `json:"snapshots"`
	Streams   int64 `json:"streams"`
	Dropped   int64 `json:"dropped"`
	Logs      int64 `json:"logs"`
	Seconds   int64 `json:"seconds"`
}

func (s *stats) snapshot(n int, since time.Time) summary {
	return summary{
		Agents: n, Connected: s.connected.Load(), Welcomes: s.welcomes.Load(), Snapshots: s.snapshots.Load(),
		Streams: s.streams.Load(), Dropped: s.dropped.Load(), Logs: s.logs.Load(), Seconds: int64(time.Since(since).Seconds()),
	}
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	fs := flag.NewFlagSet("glimt-loadtest", flag.ContinueOnError)
	hub := fs.String("hub", "ws://localhost:5080/agent/ws", "hub WebSocket URL")
	key := fs.String("key", "gp_e2e", "enrolment key every agent uses (GLIMT_DEV_ENROL_KEY on the hub)")
	n := fs.Int("n", 100, "number of agents")
	duration := fs.Duration("duration", 5*time.Minute, "how long to run (0 = until interrupted)")
	prefix := fs.String("prefix", "load", "hostname prefix: <prefix>-001 …")
	report := fs.Duration("report", 10*time.Second, "interval between progress lines")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *duration > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, *duration)
		defer cancel()
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	st := &stats{}
	start := time.Now()
	var wg sync.WaitGroup
	for i := 1; i <= *n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// Spread the dials over the first seconds, like a fleet reconnecting with jitter.
			select {
			case <-time.After(time.Duration(i) * 20 * time.Millisecond):
			case <-ctx.Done():
				return
			}
			runAgent(ctx, i, *hub, *key, *prefix, st, log)
		}(i)
	}

	ticker := time.NewTicker(*report)
	defer ticker.Stop()
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	for {
		select {
		case <-ticker.C:
			s := st.snapshot(*n, start)
			fmt.Fprintf(os.Stderr, "loadtest: %ds connected=%d/%d snapshots=%d streams=%d dropped=%d logs=%d\n", s.Seconds, s.Connected, s.Agents, s.Snapshots, s.Streams, s.Dropped, s.Logs)
		case <-done:
			s := st.snapshot(*n, start)
			out, _ := json.Marshal(s)
			fmt.Println(string(out))
			if s.Dropped > 0 || s.Welcomes < int64(*n) {
				return 1
			}
			return 0
		}
	}
}

// memStore keeps the token in memory: every run enrols afresh.
type memStore struct {
	mu    sync.Mutex
	token string
}

func (m *memStore) Load() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.token, nil
}

func (m *memStore) Save(t string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.token = t
	return nil
}

func (m *memStore) Clear() error { return m.Save("") }

func runAgent(ctx context.Context, i int, hub, key, prefix string, st *stats, log *slog.Logger) {
	hostname := fmt.Sprintf("%s-%03d", prefix, i)
	client, err := ws.New(ws.Config{
		HubURL:   hub,
		EnrolKey: key,
		Store:    &memStore{},
		Hello: func() protocol.Hello {
			return protocol.Hello{
				Hostname: hostname, AgentVersion: "loadtest",
				OS:     protocol.OSInfo{ID: "ubuntu", VersionID: "24.04", PrettyName: "Ubuntu 24.04.1 LTS"},
				Kernel: "6.8.0-45-generic", Arch: "amd64", Cores: 4, RAMBytes: 8 << 30,
				BootTime: time.Now().Add(-24 * time.Hour).Unix(), DockerMode: protocol.DockerNone,
			}
		},
		NewSession: func(ctx context.Context, w *protocol.Welcome, out ws.Sender) ws.Session {
			st.welcomes.Add(1)
			st.connected.Add(1)
			go func() {
				<-ctx.Done()
				st.connected.Add(-1)
			}()
			s := &fakeSession{ctx: ctx, out: out, id: i, st: st}
			every := time.Duration(w.SnapshotInterval) * time.Second
			if every <= 0 {
				every = 30 * time.Second
			}
			go s.snapshotLoop(every)
			return s
		},
		Logger:    log,
		UserAgent: "glimt-loadtest",
	})
	if err != nil {
		log.Error("loadtest: client", "agent", hostname, "err", err)
		return
	}
	_ = client.Run(ctx)
}

// fakeSession answers subscribe/unsubscribe and log streams with synthetic data.
type fakeSession struct {
	ctx context.Context
	out ws.Sender
	id  int
	st  *stats

	mu         sync.Mutex
	stopStream context.CancelFunc
	logStops   map[string]context.CancelFunc
}

func (s *fakeSession) snapshotLoop(every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if s.out.Send(s.snapshot()) {
			s.st.snapshots.Add(1)
		}
		select {
		case <-t.C:
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *fakeSession) Subscribe(interval time.Duration, topProcs int) {
	s.Unsubscribe()
	ctx, cancel := context.WithCancel(s.ctx)
	s.mu.Lock()
	s.stopStream = cancel
	s.mu.Unlock()
	if interval <= 0 {
		interval = time.Second
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				if s.out.Send(s.stream(topProcs)) {
					s.st.streams.Add(1)
				} else {
					s.st.dropped.Add(1)
				}
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (s *fakeSession) Unsubscribe() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopStream != nil {
		s.stopStream()
		s.stopStream = nil
	}
}

func (s *fakeSession) LogStart(req protocol.LogStart) {
	ctx, cancel := context.WithCancel(s.ctx)
	s.mu.Lock()
	if s.logStops == nil {
		s.logStops = map[string]context.CancelFunc{}
	}
	s.logStops[req.StreamID] = cancel
	s.mu.Unlock()
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		n := 0
		for {
			now := time.Now().UnixMilli()
			line := protocol.LogLine{TS: now, Unit: "loadtest.service", Priority: "info", Message: fmt.Sprintf("synthetic line %d from %s", n, req.Source)}
			if s.out.Send(&protocol.Log{Header: protocol.Header{Type: protocol.TypeLog}, StreamID: req.StreamID, Lines: []protocol.LogLine{line}}) {
				s.st.logs.Add(1)
			}
			n++
			select {
			case <-t.C:
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (s *fakeSession) LogStop(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cancel, ok := s.logStops[id]; ok {
		cancel()
		delete(s.logStops, id)
	}
}

// host gives every agent its own slow wave so the overview is not one flat line.
func (s *fakeSession) host(now time.Time) protocol.Host {
	phase := float64(s.id) / 7
	t := float64(now.Unix()) / 60
	cpu := 20 + 15*math.Sin(t+phase) + float64(s.id%10)
	memUsed := int64((0.45 + 0.1*math.Sin(t/3+phase)) * float64(8<<30))
	return protocol.Host{
		CPU:       protocol.CPU{Total: cpu, User: cpu * 0.7, System: cpu * 0.25, IOWait: cpu * 0.05, PerCore: []float64{cpu, cpu * 0.9, cpu * 1.1, cpu * 0.8}},
		Load:      []float64{cpu / 25, cpu / 30, cpu / 35},
		Mem:       protocol.Mem{Total: 8 << 30, Used: memUsed, Free: (8 << 30) - memUsed - (1 << 30), Buffers: 256 << 20, Cached: 768 << 20, SwapTotal: 2 << 30},
		UptimeSec: int64(now.Sub(now.Add(-24 * time.Hour)).Seconds()),
		Mounts:    []protocol.Mount{{Path: "/", FS: "ext4", Device: "/dev/sda1", Total: 80 << 30, Used: int64(0.4 * float64(80<<30)), InodesTotal: 5_242_880, InodesUsed: 400_000, ReadBps: 1e6, WriteBps: 2e6}},
		Ifaces:    []protocol.Iface{{Name: "eth0", IPs: []string{fmt.Sprintf("10.0.%d.%d", s.id/250, s.id%250+1)}, RxBps: 2e5 + 1e5*math.Sin(t+phase), TxBps: 5e4}},
	}
}

func (s *fakeSession) containers() []protocol.Container {
	now := time.Now().Unix()
	out := make([]protocol.Container, 0, 3)
	for c := 0; c < 3; c++ {
		id := fmt.Sprintf("%02x%03d%06x", c, s.id, s.id*7919)
		out = append(out, protocol.Container{
			ID: id + strings.Repeat("0", 64-len(id)), Name: fmt.Sprintf("app-%d", c), Image: "nginx:1.27", ImageCreated: now - 86400*30,
			State: "running", RestartCount: 0, StartedAt: now - 3600*int64(c+1), CPUPct: 1.5 + float64(c), MemBytes: 64 << 20, MemLimit: 512 << 20,
		})
	}
	return out
}

func (s *fakeSession) snapshot() *protocol.Snapshot {
	now := time.Now()
	return &protocol.Snapshot{
		Header: protocol.Header{Type: protocol.TypeSnapshot}, TS: now.UnixMilli(), Host: s.host(now), Containers: s.containers(),
		Services:    &protocol.Services{Units: []protocol.Unit{{Name: "ssh.service", State: "active"}, {Name: "cron.service", State: "active"}}, Failed: []string{}, NeedsRestart: []string{}},
		Maintenance: &protocol.Maintenance{Updates: s.id % 5, SecurityUpdates: s.id % 2, CheckedAt: now.Unix(), NeedrestartAvailable: true},
		Security: &protocol.Security{
			ListeningPorts: []protocol.ListeningPort{{Port: 22, Proto: "tcp", Process: "sshd"}, {Port: 80, Proto: "tcp", Process: "nginx"}},
			SSHFailed:      &protocol.SSHFailed{Hour: s.id % 3, Day: s.id % 20},
			Firewall:       &protocol.Firewall{UFW: "active", Fail2ban: "active", Banned: 1, Blocked: s.id},
		},
	}
}

func (s *fakeSession) stream(topProcs int) *protocol.Stream {
	now := time.Now()
	if topProcs <= 0 {
		topProcs = 5
	}
	procs := make([]protocol.Process, 0, topProcs)
	for p := 0; p < topProcs; p++ {
		procs = append(procs, protocol.Process{PID: 1000 + p, Name: fmt.Sprintf("worker-%d", p), User: "app", CPUPct: float64(topProcs-p) * 1.5, RSSBytes: int64(50+p) << 20, StartedAt: now.Unix() - 3600})
	}
	stats := make([]protocol.ContainerStats, 0, 3)
	for _, c := range s.containers() {
		stats = append(stats, protocol.ContainerStats{ID: c.ID, CPUPct: c.CPUPct, MemBytes: c.MemBytes, MemLimit: c.MemLimit, State: c.State})
	}
	return &protocol.Stream{
		Header: protocol.Header{Type: protocol.TypeStream}, TS: now.UnixMilli(), Host: s.host(now), Containers: stats, Processes: procs,
		ProcessTotals: &protocol.ProcessTotals{Total: 180, Running: 2},
	}
}
