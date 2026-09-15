package sched

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

type recorder struct {
	mu   sync.Mutex
	msgs []protocol.Message
}

func (r *recorder) Send(m protocol.Message) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.msgs = append(r.msgs, m)
	return true
}

func (r *recorder) count(typ string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, m := range r.msgs {
		if m.MessageType() == typ {
			n++
		}
	}
	return n
}

func (r *recorder) last(typ string) protocol.Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := len(r.msgs) - 1; i >= 0; i-- {
		if r.msgs[i].MessageType() == typ {
			return r.msgs[i]
		}
	}
	return nil
}

type fakeSystem struct {
	mu           sync.Mutex
	hostCalls    int
	procCalls    int
	topN         []int
	services     int
	maintenance  int
	security     int
	failServices bool
	failHost     bool
}

func (f *fakeSystem) Host(context.Context) (protocol.Host, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hostCalls++
	h := protocol.Host{CPU: protocol.CPU{Total: 12.5}, Mem: protocol.Mem{Total: 100, Used: 50, Free: 50}}
	if f.failHost {
		return h, errors.New("loadavg unreadable")
	}
	return h, nil
}

func (f *fakeSystem) Processes(_ context.Context, topN int) ([]protocol.Process, protocol.ProcessTotals, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.procCalls++
	f.topN = append(f.topN, topN)
	return []protocol.Process{{PID: 1, Name: "systemd", User: "root"}}, protocol.ProcessTotals{Total: 42, Running: 1}, nil
}

func (f *fakeSystem) Services(context.Context) (*protocol.Services, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.services++
	if f.failServices {
		return nil, errors.New("systemctl missing")
	}
	return &protocol.Services{Failed: []string{"x.service"}, NeedsRestart: []string{}}, nil
}

func (f *fakeSystem) Maintenance(context.Context) (*protocol.Maintenance, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.maintenance++
	return &protocol.Maintenance{Updates: f.maintenance}, nil
}

func (f *fakeSystem) Security(context.Context) (*protocol.Security, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.security++
	return &protocol.Security{ListeningPorts: []protocol.ListeningPort{{Port: 22, Proto: "tcp"}}}, nil
}

func (f *fakeSystem) get(field *int) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return *field
}

type fakeContainers struct {
	mu    sync.Mutex
	lists int
	stats int
}

func (f *fakeContainers) List(context.Context) ([]protocol.Container, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lists++
	return []protocol.Container{{ID: "abc", Name: "web", Image: "nginx", State: "running"}, {ID: "def", Name: "db", Image: "pg", State: "stopped"}}, nil
}

func (f *fakeContainers) Stats(_ context.Context, cs []protocol.Container) ([]protocol.ContainerStats, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stats++
	out := make([]protocol.ContainerStats, len(cs))
	for i, c := range cs {
		out[i] = protocol.ContainerStats{ID: c.ID, State: c.State}
		if c.State == "running" {
			out[i].CPUPct, out[i].MemBytes = 5, 1000
		}
	}
	return out, nil
}

func (f *fakeContainers) get(field *int) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return *field
}

type fakePeriodic struct {
	mu       sync.Mutex
	refreshs int
	at       time.Time
	now      func() time.Time
}

func (p *fakePeriodic) Refresh(context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.refreshs++
	p.at = p.now()
	return nil
}

func (p *fakePeriodic) RefreshedAt() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.at
}

func (p *fakePeriodic) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.refreshs
}

// countingHandler counts slog records at or above Warn.
type countingHandler struct {
	mu    sync.Mutex
	warns int
}

func (h *countingHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h *countingHandler) Handle(_ context.Context, r slog.Record) error {
	if r.Level >= slog.LevelWarn {
		h.mu.Lock()
		h.warns++
		h.mu.Unlock()
	}
	return nil
}
func (h *countingHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *countingHandler) WithGroup(string) slog.Handler      { return h }
func (h *countingHandler) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.warns
}

// settle lets every goroutine in the bubble run until it blocks, then checks cond.
func settle(t *testing.T, cond func() bool) {
	t.Helper()
	synctest.Wait()
	if !cond() {
		t.Fatal("condition not met")
	}
}

type fixture struct {
	sys    *fakeSystem
	docker *fakeContainers
	per    *fakePeriodic
	rec    *recorder
	cache  *MaintenanceCache
	logs   *countingHandler
	s      *Scheduler
	cancel context.CancelFunc
}

func newFixture(t *testing.T, tweak func(*Config)) *fixture {
	t.Helper()
	f := &fixture{sys: &fakeSystem{}, docker: &fakeContainers{}, rec: &recorder{}, logs: &countingHandler{}}
	f.per = &fakePeriodic{now: time.Now}
	f.cache = NewMaintenanceCache(f.sys, time.Now)
	cfg := Config{
		SnapshotInterval: 30 * time.Second, MaintenanceInterval: 10 * time.Minute,
		System: f.sys, Containers: f.docker, Maintenance: f.cache, Periodics: []Periodic{f.per},
		Sink: f.rec, Logger: slog.New(f.logs),
	}
	if tweak != nil {
		tweak(&cfg)
	}
	f.s = New(cfg)
	ctx, cancel := context.WithCancel(context.Background())
	f.cancel = cancel
	go f.s.Run(ctx)
	settle(t, func() bool { return f.rec.count(protocol.TypeSnapshot) == 1 })
	return f
}

func TestSnapshotCadenceAndMaintenance(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newFixture(t, nil)
		defer f.cancel()
		snap := f.rec.last(protocol.TypeSnapshot).(*protocol.Snapshot)
		if snap.TS != time.Now().UnixMilli() || snap.Host.CPU.Total != 12.5 {
			t.Errorf("snapshot payload %+v", snap)
		}
		if snap.Maintenance == nil || snap.Maintenance.Updates != 1 || snap.Services == nil || snap.Security == nil {
			t.Errorf("sections missing: maintenance=%+v services=%+v security=%+v", snap.Maintenance, snap.Services, snap.Security)
		}
		if len(snap.Containers) != 2 || snap.Containers[0].CPUPct != 5 || snap.Containers[0].MemBytes != 1000 || snap.Containers[1].CPUPct != 0 {
			t.Errorf("containers %+v", snap.Containers)
		}
		if f.per.count() != 1 || f.sys.get(&f.sys.maintenance) != 1 {
			t.Errorf("periodic=%d maintenance=%d at start", f.per.count(), f.sys.get(&f.sys.maintenance))
		}

		time.Sleep(30 * time.Second)
		settle(t, func() bool { return f.rec.count(protocol.TypeSnapshot) == 2 })
		time.Sleep(30 * time.Second)
		settle(t, func() bool { return f.rec.count(protocol.TypeSnapshot) == 3 })
		if f.sys.get(&f.sys.maintenance) != 1 || f.docker.get(&f.docker.lists) != 3 || f.sys.get(&f.sys.services) != 3 {
			t.Errorf("maintenance=%d lists=%d services=%d after two ticks", f.sys.get(&f.sys.maintenance), f.docker.get(&f.docker.lists), f.sys.get(&f.sys.services))
		}
		if f.rec.count(protocol.TypeStream) != 0 {
			t.Error("stream without subscription")
		}

		// The maintenance tick at 10 min refreshes the cache and the periodic.
		time.Sleep(9 * time.Minute)
		settle(t, func() bool { return f.sys.get(&f.sys.maintenance) == 2 && f.per.count() == 2 })
		time.Sleep(30 * time.Second)
		settle(t, func() bool {
			s, _ := f.rec.last(protocol.TypeSnapshot).(*protocol.Snapshot)
			return s != nil && s.Maintenance != nil && s.Maintenance.Updates == 2
		})
	})
}

func TestStreamOnlyWhileSubscribed(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newFixture(t, nil)
		defer f.cancel()
		f.s.Subscribe(time.Second, 10)
		synctest.Wait()
		time.Sleep(time.Second)
		settle(t, func() bool { return f.rec.count(protocol.TypeStream) == 1 })
		time.Sleep(time.Second)
		settle(t, func() bool { return f.rec.count(protocol.TypeStream) == 2 })
		st := f.rec.last(protocol.TypeStream).(*protocol.Stream)
		if len(st.Processes) != 1 || st.ProcessTotals == nil || st.ProcessTotals.Total != 42 || len(st.Containers) != 2 || st.Containers[0].CPUPct != 5 || st.Host.CPU.Total != 12.5 {
			t.Errorf("stream payload %+v", st)
		}
		f.sys.mu.Lock()
		topN := append([]int(nil), f.sys.topN...)
		f.sys.mu.Unlock()
		if len(topN) != 2 || topN[0] != 10 {
			t.Errorf("topN %v", topN)
		}

		f.s.Unsubscribe()
		synctest.Wait()
		time.Sleep(time.Second)
		time.Sleep(time.Second)
		synctest.Wait()
		if f.rec.count(protocol.TypeStream) != 2 {
			t.Errorf("stream continued after unsubscribe: %d", f.rec.count(protocol.TypeStream))
		}

		// Re-subscribe without topProcs uses the default 40.
		f.s.Subscribe(5*time.Second, 0)
		synctest.Wait()
		time.Sleep(5 * time.Second)
		settle(t, func() bool { return f.rec.count(protocol.TypeStream) == 3 })
		f.sys.mu.Lock()
		lastTop := f.sys.topN[len(f.sys.topN)-1]
		f.sys.mu.Unlock()
		if lastTop != 40 {
			t.Errorf("default topProcs = %d", lastTop)
		}
	})
}

func TestMeasurementReusedWhenSnapshotAndStreamCoincide(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newFixture(t, nil)
		defer f.cancel()
		f.s.Subscribe(time.Second, 40)
		synctest.Wait()
		time.Sleep(time.Second)
		settle(t, func() bool { return f.rec.count(protocol.TypeStream) == 1 })
		hostCalls := f.sys.get(&f.sys.hostCalls)
		// A snapshot at the same instant reuses the stream's reading.
		snap := f.s.Snapshot(context.Background())
		if f.sys.get(&f.sys.hostCalls) != hostCalls || snap.Containers[0].CPUPct != 5 {
			t.Errorf("host calls %d → %d; snapshot should reuse the measurement", hostCalls, f.sys.get(&f.sys.hostCalls))
		}
		// Half a second later (stream interval 1 s → window 500 ms) it measures again.
		time.Sleep(500 * time.Millisecond)
		f.s.Snapshot(context.Background())
		if f.sys.get(&f.sys.hostCalls) != hostCalls+1 {
			t.Errorf("host calls %d, want %d", f.sys.get(&f.sys.hostCalls), hostCalls+1)
		}
	})
}

func TestCollectorErrorsAreRateLimitedAndSectionsOmitted(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newFixture(t, func(c *Config) { c.System.(*fakeSystem).failServices = true; c.System.(*fakeSystem).failHost = true })
		defer f.cancel()
		snap := f.rec.last(protocol.TypeSnapshot).(*protocol.Snapshot)
		if snap.Services != nil || snap.Security == nil || snap.Host.CPU.Total != 12.5 {
			t.Errorf("services should be omitted, the rest kept: %+v", snap)
		}
		if f.logs.count() != 2 {
			t.Errorf("%d warnings after the first snapshot, want 2 (host, services)", f.logs.count())
		}
		time.Sleep(30 * time.Second)
		settle(t, func() bool { return f.rec.count(protocol.TypeSnapshot) == 2 })
		time.Sleep(30 * time.Second)
		settle(t, func() bool { return f.rec.count(protocol.TypeSnapshot) == 3 })
		if f.logs.count() != 2 {
			t.Errorf("%d warnings after three snapshots, want still 2", f.logs.count())
		}
		time.Sleep(time.Hour)
		settle(t, func() bool { return f.rec.count(protocol.TypeSnapshot) >= 4 })
		settle(t, func() bool { return f.logs.count() == 4 })
	})
}

func TestDockerEventDebounce(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newFixture(t, nil)
		defer f.cancel()
		if f.docker.get(&f.docker.lists) != 1 {
			t.Fatalf("lists = %d", f.docker.get(&f.docker.lists))
		}
		f.s.DockerChanged()
		f.s.DockerChanged()
		f.s.DockerChanged()
		synctest.Wait()
		time.Sleep(time.Second)
		synctest.Wait()
		if f.rec.count(protocol.TypeSnapshot) != 1 {
			t.Errorf("snapshot before the debounce elapsed")
		}
		// Another event restarts the debounce: due 2 s from now, not 1 s.
		f.s.DockerChanged()
		synctest.Wait()
		time.Sleep(1500 * time.Millisecond)
		synctest.Wait()
		if f.rec.count(protocol.TypeSnapshot) != 1 {
			t.Errorf("snapshot before the restarted debounce elapsed")
		}
		time.Sleep(500 * time.Millisecond)
		settle(t, func() bool { return f.rec.count(protocol.TypeSnapshot) == 2 })
		if f.docker.get(&f.docker.lists) != 2 {
			t.Errorf("lists = %d after the event snapshot", f.docker.get(&f.docker.lists))
		}
	})
}

func TestMaintenanceCacheSurvivesReconnect(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		sys := &fakeSystem{}
		cache := NewMaintenanceCache(sys, time.Now)
		if cache.Value() != nil || !cache.RefreshedAt().IsZero() {
			t.Fatal("empty cache should have no value")
		}
		if err := cache.Refresh(context.Background()); err != nil || cache.Value().Updates != 1 {
			t.Fatalf("refresh: %v %+v", err, cache.Value())
		}
		// A new connection one minute later does not re-run the check.
		time.Sleep(time.Minute)
		rec := &recorder{}
		s := New(Config{System: sys, Maintenance: cache, Sink: rec})
		ctx, cancel := context.WithCancel(context.Background())
		go s.Run(ctx)
		settle(t, func() bool { return rec.count(protocol.TypeSnapshot) == 1 })
		cancel()
		if sys.get(&sys.maintenance) != 1 {
			t.Errorf("maintenance re-run on reconnect: %d", sys.get(&sys.maintenance))
		}
		// Ten minutes later it is stale and refreshed before the first snapshot.
		time.Sleep(10 * time.Minute)
		rec2 := &recorder{}
		s2 := New(Config{System: sys, Maintenance: cache, Sink: rec2})
		ctx2, cancel2 := context.WithCancel(context.Background())
		defer cancel2()
		go s2.Run(ctx2)
		settle(t, func() bool { return rec2.count(protocol.TypeSnapshot) == 1 })
		if sys.get(&sys.maintenance) != 2 || rec2.last(protocol.TypeSnapshot).(*protocol.Snapshot).Maintenance.Updates != 2 {
			t.Errorf("stale cache not refreshed: %d", sys.get(&sys.maintenance))
		}
	})
}

func TestPrimeAndStreamWithoutContainers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		sys := &fakeSystem{}
		s := New(Config{System: sys, Sink: &recorder{}})
		s.Prime(context.Background())
		time.Sleep(time.Second)
		st := s.Stream(context.Background(), 0)
		if st.Host.CPU.Total != 12.5 || len(st.Containers) != 0 || st.ProcessTotals == nil {
			t.Errorf("stream %+v", st)
		}
		if sys.get(&sys.hostCalls) != 2 {
			t.Errorf("host calls %d", sys.get(&sys.hostCalls))
		}
	})
}
