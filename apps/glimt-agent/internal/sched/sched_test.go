package sched

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

type recorder struct {
	mu   sync.Mutex
	msgs []protocol.Message
	at   []time.Time
}

func (r *recorder) Send(m protocol.Message) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.msgs = append(r.msgs, m)
	r.at = append(r.at, time.Now())
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

func (r *recorder) firstAt(typ string) (time.Time, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, m := range r.msgs {
		if m.MessageType() == typ {
			return r.at[i], true
		}
	}
	return time.Time{}, false
}

type fakeCollector struct{ fail bool }

func (f fakeCollector) Host() (protocol.Host, error) {
	h := protocol.Host{CPU: protocol.CPU{Total: 12.5}, Mem: protocol.Mem{Total: 100, Used: 50, Free: 50}}
	if f.fail {
		return h, errors.New("loadavg unreadable")
	}
	return h, nil
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	return cond()
}

func TestSnapshotImmediatelyThenPeriodic(t *testing.T) {
	rec := &recorder{}
	maint := 0
	var mmu sync.Mutex
	s := New(Config{
		SnapshotInterval:    30 * time.Millisecond,
		MaintenanceInterval: 25 * time.Millisecond,
		Collector:           fakeCollector{},
		Sink:                rec,
		OnMaintenance:       func() { mmu.Lock(); maint++; mmu.Unlock() },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	start := time.Now()
	go s.Run(ctx)

	if !waitFor(t, time.Second, func() bool { return rec.count(protocol.TypeSnapshot) >= 1 }) {
		t.Fatal("no snapshot")
	}
	if at, _ := rec.firstAt(protocol.TypeSnapshot); at.Sub(start) > 15*time.Millisecond {
		t.Errorf("first snapshot came after %v, want immediately", at.Sub(start))
	}
	if !waitFor(t, time.Second, func() bool { return rec.count(protocol.TypeSnapshot) >= 3 }) {
		t.Errorf("only %d snapshots", rec.count(protocol.TypeSnapshot))
	}
	if !waitFor(t, time.Second, func() bool { mmu.Lock(); defer mmu.Unlock(); return maint >= 2 }) {
		t.Errorf("maintenance ran %d times", maint)
	}
	if rec.count(protocol.TypeStream) != 0 {
		t.Error("stream sent without subscription")
	}
	snap := rec.msgs[0].(*protocol.Snapshot)
	if snap.TS == 0 || snap.Host.CPU.Total != 12.5 {
		t.Errorf("snapshot payload: %+v", snap)
	}
}

func TestStreamOnlyWhileSubscribed(t *testing.T) {
	rec := &recorder{}
	s := New(Config{SnapshotInterval: time.Hour, MaintenanceInterval: time.Hour, Collector: fakeCollector{}, Sink: rec})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)

	time.Sleep(20 * time.Millisecond)
	if rec.count(protocol.TypeStream) != 0 {
		t.Fatal("stream before subscribe")
	}
	s.Subscribe(5*time.Millisecond, 40)
	if !waitFor(t, time.Second, func() bool { return rec.count(protocol.TypeStream) >= 3 }) {
		t.Fatalf("only %d streams after subscribe", rec.count(protocol.TypeStream))
	}
	s.Unsubscribe()
	time.Sleep(20 * time.Millisecond)
	n := rec.count(protocol.TypeStream)
	time.Sleep(40 * time.Millisecond)
	if rec.count(protocol.TypeStream) != n {
		t.Errorf("stream continued after unsubscribe: %d → %d", n, rec.count(protocol.TypeStream))
	}

	// Re-subscribe with a new interval works.
	s.Subscribe(5*time.Millisecond, 10)
	if !waitFor(t, time.Second, func() bool { return rec.count(protocol.TypeStream) >= n+2 }) {
		t.Error("stream did not resume")
	}
}

func TestCollectorErrorIsRateLimited(t *testing.T) {
	rec := &recorder{}
	s := New(Config{SnapshotInterval: 5 * time.Millisecond, MaintenanceInterval: time.Hour, Collector: fakeCollector{fail: true}, Sink: rec})
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	s.Run(ctx)
	if rec.count(protocol.TypeSnapshot) < 3 {
		t.Errorf("failing collector must not stop snapshots, got %d", rec.count(protocol.TypeSnapshot))
	}
	if s.lastErrLog.IsZero() {
		t.Error("error should have been logged once")
	}
}
