// Package sched drives the tickers of one connection: snapshot every
// heartbeat (the first one immediately after welcome), stream every
// intervalMs while subscribed, and the maintenance refresh every ten
// minutes. Docker events trigger an extra snapshot after a short debounce.
package sched

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// Sink receives outbound messages (the WebSocket send queue).
type Sink interface {
	Send(protocol.Message) bool
}

// System is the host collector facade (internal/collect.System).
type System interface {
	Host(ctx context.Context) (protocol.Host, error)
	Processes(ctx context.Context, topN int) ([]protocol.Process, protocol.ProcessTotals, error)
	Services(ctx context.Context) (*protocol.Services, error)
	Maintenance(ctx context.Context) (*protocol.Maintenance, error)
	Security(ctx context.Context) (*protocol.Security, error)
}

// HealthChecker runs a container node's health URL and TCP checks once per
// snapshot (internal/health.Checker); nil when not configured.
type HealthChecker interface {
	Run(ctx context.Context) (*protocol.Health, []protocol.Check)
}

// Containers is the Docker engine (internal/docker.Engine); nil when off.
type Containers interface {
	List(ctx context.Context) ([]protocol.Container, error)
	Stats(ctx context.Context, containers []protocol.Container) ([]protocol.ContainerStats, error)
}

// Config for one scheduler.
type Config struct {
	SnapshotInterval    time.Duration // default 30 s
	MaintenanceInterval time.Duration // default 10 min
	System              System
	Containers          Containers        // nil = no containers
	Maintenance         *MaintenanceCache // nil = no maintenance section
	Periodics           []Periodic        // refreshed on the maintenance tick (journal counter, ...)
	Health              HealthChecker     // nil = no health/checks sections (servers)
	OnMaintenance       func(ctx context.Context)
	Sink                Sink
	Logger              *slog.Logger
	Clock               Clock

	ErrorLogInterval time.Duration // a failing collector is logged this often, default 1 h
	CollectTimeout   time.Duration // per collector call, default 10 s
	DockerDebounce   time.Duration // events → snapshot, default 2 s
	ReuseWindow      time.Duration // a measurement younger than this is reused, default 1 s
	DefaultTopProcs  int           // when subscribe has no topProcs, default 40
}

// Scheduler runs the tickers for one connection.
type Scheduler struct {
	cfg   Config
	log   *slog.Logger
	clock Clock

	mu       sync.Mutex
	interval time.Duration // stream interval, 0 = unsubscribed
	topProcs int
	changed  chan struct{}
	docker   chan struct{}

	measureMu  sync.Mutex
	last       *measurement
	containers []protocol.Container
	snapshots  int

	errMu  sync.Mutex
	errLog map[string]time.Time
}

// measurement is one reading of the fast-changing data, shared by a
// snapshot and a stream that coincide.
type measurement struct {
	at    time.Time
	host  protocol.Host
	stats []protocol.ContainerStats
}

// New builds a scheduler; call Run in a goroutine.
func New(cfg Config) *Scheduler {
	if cfg.SnapshotInterval <= 0 {
		cfg.SnapshotInterval = 30 * time.Second
	}
	if cfg.MaintenanceInterval <= 0 {
		cfg.MaintenanceInterval = 10 * time.Minute
	}
	if cfg.Clock == nil {
		cfg.Clock = RealClock{}
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.ErrorLogInterval <= 0 {
		cfg.ErrorLogInterval = time.Hour
	}
	if cfg.CollectTimeout <= 0 {
		cfg.CollectTimeout = 10 * time.Second
	}
	if cfg.DockerDebounce <= 0 {
		cfg.DockerDebounce = 2 * time.Second
	}
	if cfg.ReuseWindow <= 0 {
		cfg.ReuseWindow = time.Second
	}
	if cfg.DefaultTopProcs <= 0 {
		cfg.DefaultTopProcs = 40
	}
	return &Scheduler{cfg: cfg, log: cfg.Logger, clock: cfg.Clock, changed: make(chan struct{}, 1), docker: make(chan struct{}, 1), errLog: map[string]time.Time{}}
}

// Subscribe starts (or re-times) the stream ticker.
func (s *Scheduler) Subscribe(interval time.Duration, topProcs int) {
	if interval <= 0 {
		interval = time.Second
	}
	if topProcs <= 0 {
		topProcs = s.cfg.DefaultTopProcs
	}
	s.mu.Lock()
	s.interval, s.topProcs = interval, topProcs
	s.mu.Unlock()
	notify(s.changed)
}

// Unsubscribe stops the stream ticker.
func (s *Scheduler) Unsubscribe() {
	s.mu.Lock()
	s.interval, s.topProcs = 0, 0
	s.mu.Unlock()
	notify(s.changed)
}

// DockerChanged is called for every Docker container event; after a
// debounce the container list is refreshed and an extra snapshot sent.
func (s *Scheduler) DockerChanged() { notify(s.docker) }

func notify(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

// Run blocks until ctx is done. Stale periodic data is refreshed first,
// then the first snapshot goes out immediately.
func (s *Scheduler) Run(ctx context.Context) {
	go s.streamLoop(ctx)

	s.refreshStale(ctx)
	s.sendSnapshot(ctx)

	snap := s.clock.NewTicker(s.cfg.SnapshotInterval)
	defer snap.Stop()
	maint := s.clock.NewTicker(s.cfg.MaintenanceInterval)
	defer maint.Stop()
	var debounce Timer
	var debounceC <-chan time.Time
	defer func() {
		if debounce != nil {
			debounce.Stop()
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case <-snap.C():
			s.sendSnapshot(ctx)
		case <-maint.C():
			s.maintenance(ctx)
		case <-s.docker:
			if debounce != nil {
				debounce.Stop()
			}
			debounce = s.clock.NewTimer(s.cfg.DockerDebounce)
			debounceC = debounce.C()
		case <-debounceC:
			debounce, debounceC = nil, nil
			s.log.Debug("docker changed; sending snapshot")
			s.sendSnapshot(ctx)
		}
	}
}

func (s *Scheduler) streamLoop(ctx context.Context) {
	var ticker Ticker
	var tick <-chan time.Time
	stop := func() {
		if ticker != nil {
			ticker.Stop()
			ticker, tick = nil, nil
		}
	}
	defer stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.changed:
			s.mu.Lock()
			iv := s.interval
			s.mu.Unlock()
			stop()
			if iv > 0 {
				s.log.Debug("stream subscribed", "interval", iv)
				ticker = s.clock.NewTicker(iv)
				tick = ticker.C()
			} else {
				s.log.Debug("stream unsubscribed")
			}
		case <-tick:
			s.sendStream(ctx)
		}
	}
}

// --- periodic -------------------------------------------------------------

func (s *Scheduler) periodics() []Periodic {
	ps := append([]Periodic(nil), s.cfg.Periodics...)
	if s.cfg.Maintenance != nil {
		ps = append(ps, s.cfg.Maintenance)
	}
	return ps
}

// refreshStale refreshes periodic data older than the maintenance interval
// (a reconnect within the interval keeps the cached values).
func (s *Scheduler) refreshStale(ctx context.Context) {
	now := s.clock.Now()
	for _, p := range s.periodics() {
		if now.Sub(p.RefreshedAt()) >= s.cfg.MaintenanceInterval {
			s.refresh(ctx, p)
		}
	}
	if s.cfg.OnMaintenance != nil {
		s.cfg.OnMaintenance(ctx)
	}
}

func (s *Scheduler) maintenance(ctx context.Context) {
	for _, p := range s.periodics() {
		s.refresh(ctx, p)
	}
	if s.cfg.OnMaintenance != nil {
		s.cfg.OnMaintenance(ctx)
	}
}

func (s *Scheduler) refresh(ctx context.Context, p Periodic) {
	cctx, cancel := context.WithTimeout(ctx, s.cfg.CollectTimeout)
	defer cancel()
	if err := p.Refresh(cctx); err != nil {
		name := "periodic"
		if _, ok := p.(*MaintenanceCache); ok {
			name = "maintenance"
		} else if n, ok := p.(interface{ Name() string }); ok {
			name = n.Name()
		}
		s.fail(name, err)
	}
}

// --- collecting -----------------------------------------------------------

// fail logs a collector error at most once per ErrorLogInterval per name.
func (s *Scheduler) fail(name string, err error) {
	now := s.clock.Now()
	s.errMu.Lock()
	last, seen := s.errLog[name]
	if !seen || now.Sub(last) >= s.cfg.ErrorLogInterval {
		s.errLog[name] = now
		s.errMu.Unlock()
		s.log.Warn("collector failed; section omitted", "collector", name, "err", err, "nextLog", s.cfg.ErrorLogInterval)
		return
	}
	s.errMu.Unlock()
	s.log.Debug("collector failed", "collector", name, "err", err)
}

func (s *Scheduler) withTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, s.cfg.CollectTimeout)
}

// measure returns the host reading and container stats, reusing the
// previous reading when it is younger than the reuse window.
func (s *Scheduler) measure(ctx context.Context) *measurement {
	s.measureMu.Lock()
	defer s.measureMu.Unlock()
	now := s.clock.Now()
	window := s.cfg.ReuseWindow
	s.mu.Lock()
	if s.interval > 0 && s.interval/2 < window {
		window = s.interval / 2
	}
	s.mu.Unlock()
	if s.last != nil && now.Sub(s.last.at) < window && now.Sub(s.last.at) >= 0 {
		return s.last
	}
	m := &measurement{at: now}
	cctx, cancel := s.withTimeout(ctx)
	host, err := s.cfg.System.Host(cctx)
	cancel()
	if err != nil {
		s.fail("host", err)
	}
	m.host = host
	if s.cfg.Containers != nil && len(s.containers) > 0 {
		cctx, cancel := s.withTimeout(ctx)
		stats, err := s.cfg.Containers.Stats(cctx, s.containers)
		cancel()
		if err != nil {
			s.fail("docker stats", err)
		}
		m.stats = stats
	}
	s.last = m
	return m
}

// refreshContainers lists containers; on error the previous list is kept.
func (s *Scheduler) refreshContainers(ctx context.Context) {
	if s.cfg.Containers == nil {
		return
	}
	cctx, cancel := s.withTimeout(ctx)
	list, err := s.cfg.Containers.List(cctx)
	cancel()
	s.measureMu.Lock()
	defer s.measureMu.Unlock()
	if err != nil {
		s.fail("docker list", err)
		return
	}
	s.containers = list
}

// Snapshot builds one snapshot message (also used by `glimt-agent snapshot`).
func (s *Scheduler) Snapshot(ctx context.Context) *protocol.Snapshot {
	s.refreshContainers(ctx)
	m := s.measure(ctx)
	msg := &protocol.Snapshot{TS: s.clock.Now().UnixMilli(), Host: m.host}

	s.measureMu.Lock()
	if len(s.containers) > 0 {
		msg.Containers = make([]protocol.Container, len(s.containers))
		copy(msg.Containers, s.containers)
	}
	s.measureMu.Unlock()
	mergeStats(msg.Containers, m.stats)

	if cctx, cancel := s.withTimeout(ctx); true {
		if services, err := s.cfg.System.Services(cctx); err != nil {
			s.fail("services", err)
		} else {
			msg.Services = services
		}
		cancel()
	}
	if s.cfg.Maintenance != nil {
		msg.Maintenance = s.cfg.Maintenance.Value()
	}
	if cctx, cancel := s.withTimeout(ctx); true {
		if security, err := s.cfg.System.Security(cctx); err != nil {
			s.fail("security", err)
		} else {
			msg.Security = security
		}
		cancel()
	}
	if s.cfg.Health != nil {
		cctx, cancel := s.withTimeout(ctx)
		msg.Health, msg.Checks = s.cfg.Health.Run(cctx)
		cancel()
	}
	return msg
}

// Stream builds one stream message with the top processes.
func (s *Scheduler) Stream(ctx context.Context, topProcs int) *protocol.Stream {
	if topProcs <= 0 {
		topProcs = s.cfg.DefaultTopProcs
	}
	m := s.measure(ctx)
	msg := &protocol.Stream{TS: s.clock.Now().UnixMilli(), Host: m.host, Containers: m.stats}
	cctx, cancel := s.withTimeout(ctx)
	defer cancel()
	procs, totals, err := s.cfg.System.Processes(cctx, topProcs)
	if err != nil {
		s.fail("processes", err)
		return msg
	}
	msg.Processes = procs
	msg.ProcessTotals = &totals
	return msg
}

// Prime takes a first measurement so the next one has rates.
func (s *Scheduler) Prime(ctx context.Context) {
	s.refreshContainers(ctx)
	s.measureMu.Lock()
	s.last = nil
	s.measureMu.Unlock()
	s.measure(ctx)
}

func (s *Scheduler) sendSnapshot(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	msg := s.Snapshot(ctx)
	if !s.cfg.Sink.Send(msg) {
		s.log.Warn("snapshot not queued")
		return
	}
	s.measureMu.Lock()
	s.snapshots++
	n := s.snapshots
	s.measureMu.Unlock()
	attrs := []any{"n", n, "containers", len(msg.Containers), "cpu", msg.Host.CPU.Total, "memUsed", msg.Host.Mem.Used,
		"services", msg.Services != nil, "maintenance", msg.Maintenance != nil, "security", msg.Security != nil}
	if n == 1 {
		s.log.Info("snapshot sent", attrs...)
	} else {
		s.log.Debug("snapshot sent", attrs...)
	}
}

func (s *Scheduler) sendStream(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	s.mu.Lock()
	top := s.topProcs
	s.mu.Unlock()
	s.cfg.Sink.Send(s.Stream(ctx, top))
}

func mergeStats(containers []protocol.Container, stats []protocol.ContainerStats) {
	if len(containers) == 0 || len(stats) == 0 {
		return
	}
	byID := make(map[string]protocol.ContainerStats, len(stats))
	for _, st := range stats {
		byID[st.ID] = st
	}
	for i := range containers {
		if st, ok := byID[containers[i].ID]; ok {
			containers[i].CPUPct, containers[i].MemBytes, containers[i].MemLimit = st.CPUPct, st.MemBytes, st.MemLimit
			containers[i].RxBps, containers[i].TxBps = st.RxBps, st.TxBps
		}
	}
}
