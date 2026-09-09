// Package sched drives the three tickers of a connection: snapshot every
// heartbeat (the first one immediately), stream every intervalMs while
// subscribed, and maintenance every ten minutes.
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

// Collector produces host metrics. The error lists parts that failed; the
// Host is still sent with what was read.
type Collector interface {
	Host() (protocol.Host, error)
}

// Config for one scheduler.
type Config struct {
	SnapshotInterval    time.Duration // default 30 s
	MaintenanceInterval time.Duration // default 10 min
	Collector           Collector
	Sink                Sink
	Logger              *slog.Logger
	Now                 func() time.Time // injectable for tests
	OnMaintenance       func()           // placeholder until step 1.7; nil is fine
	ErrorLogInterval    time.Duration    // how often a failing collector is logged (default 1 h)
}

// Scheduler runs the tickers for one connection.
type Scheduler struct {
	cfg Config
	log *slog.Logger

	mu       sync.Mutex
	interval time.Duration // stream interval, 0 = unsubscribed
	topProcs int
	changed  chan struct{}

	lastErrLog time.Time
}

// New builds a scheduler; call Run in a goroutine.
func New(cfg Config) *Scheduler {
	if cfg.SnapshotInterval <= 0 {
		cfg.SnapshotInterval = 30 * time.Second
	}
	if cfg.MaintenanceInterval <= 0 {
		cfg.MaintenanceInterval = 10 * time.Minute
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.ErrorLogInterval <= 0 {
		cfg.ErrorLogInterval = time.Hour
	}
	return &Scheduler{cfg: cfg, log: cfg.Logger, changed: make(chan struct{}, 1)}
}

// Subscribe starts (or re-times) the stream ticker.
func (s *Scheduler) Subscribe(interval time.Duration, topProcs int) {
	if interval <= 0 {
		interval = time.Second
	}
	s.mu.Lock()
	s.interval, s.topProcs = interval, topProcs
	s.mu.Unlock()
	s.notify()
}

// Unsubscribe stops the stream ticker.
func (s *Scheduler) Unsubscribe() {
	s.mu.Lock()
	s.interval, s.topProcs = 0, 0
	s.mu.Unlock()
	s.notify()
}

func (s *Scheduler) notify() {
	select {
	case s.changed <- struct{}{}:
	default:
	}
}

// Run blocks until ctx is done. The first snapshot is sent immediately.
func (s *Scheduler) Run(ctx context.Context) {
	go s.streamLoop(ctx)

	s.maintenance()
	s.snapshot()

	snap := time.NewTicker(s.cfg.SnapshotInterval)
	defer snap.Stop()
	maint := time.NewTicker(s.cfg.MaintenanceInterval)
	defer maint.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-snap.C:
			s.snapshot()
		case <-maint.C:
			s.maintenance()
		}
	}
}

func (s *Scheduler) streamLoop(ctx context.Context) {
	var ticker *time.Ticker
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
				ticker = time.NewTicker(iv)
				tick = ticker.C
			} else {
				s.log.Debug("stream unsubscribed")
			}
		case <-tick:
			s.stream()
		}
	}
}

func (s *Scheduler) collectHost() protocol.Host {
	host, err := s.cfg.Collector.Host()
	if err != nil {
		now := s.cfg.Now()
		if now.Sub(s.lastErrLog) >= s.cfg.ErrorLogInterval {
			s.lastErrLog = now
			s.log.Warn("host collector partially failed", "err", err)
		}
	}
	return host
}

func (s *Scheduler) snapshot() {
	msg := &protocol.Snapshot{TS: s.cfg.Now().UnixMilli(), Host: s.collectHost()}
	if !s.cfg.Sink.Send(msg) {
		s.log.Warn("snapshot not queued")
	}
}

func (s *Scheduler) stream() {
	msg := &protocol.Stream{TS: s.cfg.Now().UnixMilli(), Host: s.collectHost()}
	s.cfg.Sink.Send(msg)
}

func (s *Scheduler) maintenance() {
	if s.cfg.OnMaintenance != nil {
		s.cfg.OnMaintenance()
	}
}
