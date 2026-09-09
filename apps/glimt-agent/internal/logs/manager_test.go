package logs

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/journal"
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

func (r *recorder) logs(id string) (lines []protocol.LogLine, dropped int, msgs int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, m := range r.msgs {
		if l, ok := m.(*protocol.Log); ok && l.StreamID == id {
			lines = append(lines, l.Lines...)
			dropped += l.Dropped
			msgs++
		}
	}
	return
}

func (r *recorder) end(id string) *protocol.LogEnd {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, m := range r.msgs {
		if e, ok := m.(*protocol.LogEnd); ok && e.StreamID == id {
			return e
		}
	}
	return nil
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("condition not met")
}

// emitN sends n lines then behaves like the tail: blocks until cancelled
// (follow=true) or returns retErr.
func emitN(n int, follow bool, retErr error) Opener {
	return func(ctx context.Context, req protocol.LogStart, out chan<- protocol.LogLine) error {
		for i := 0; i < n; i++ {
			select {
			case out <- protocol.LogLine{TS: int64(i), Unit: req.Source, Message: fmt.Sprint("line ", i)}:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		if follow {
			<-ctx.Done()
			return ctx.Err()
		}
		return retErr
	}
}

func newManager(rec *recorder, journalOp, webOp, containerOp Opener, extra func(*Config)) *Manager {
	cfg := Config{Sink: rec, Journal: journalOp, Web: webOp, Container: containerOp, BatchInterval: 10 * time.Millisecond}
	if extra != nil {
		extra(&cfg)
	}
	return New(cfg)
}

func TestBatchingAndEOF(t *testing.T) {
	rec := &recorder{}
	m := newManager(rec, emitN(5, false, nil), nil, nil, nil)
	m.Start(context.Background(), protocol.LogStart{StreamID: "s1", Source: "auth"})
	waitFor(t, func() bool { return rec.end("s1") != nil })
	lines, dropped, msgs := rec.logs("s1")
	if len(lines) != 5 || dropped != 0 || msgs != 1 || lines[0].Unit != "auth" || lines[4].Message != "line 4" {
		t.Errorf("lines=%d dropped=%d msgs=%d %+v", len(lines), dropped, msgs, lines)
	}
	if e := rec.end("s1"); e.Reason != protocol.LogEndEOF {
		t.Errorf("end %+v", e)
	}
	if m.Count() != 0 {
		t.Error("stream not removed after eof")
	}
}

func TestMaxBatchSplitsMessages(t *testing.T) {
	rec := &recorder{}
	m := newManager(rec, emitN(450, false, nil), nil, nil, func(c *Config) { c.BatchInterval = time.Hour; c.BufferSize = 1000 })
	m.Start(context.Background(), protocol.LogStart{StreamID: "big", Source: "journal"})
	waitFor(t, func() bool { return rec.end("big") != nil })
	lines, _, msgs := rec.logs("big")
	if len(lines) != 450 || msgs != 3 {
		t.Errorf("lines=%d msgs=%d", len(lines), msgs)
	}
	rec.mu.Lock()
	first := rec.msgs[0].(*protocol.Log)
	rec.mu.Unlock()
	if len(first.Lines) != 200 {
		t.Errorf("first batch %d lines", len(first.Lines))
	}
}

func TestBufferOverflowCountsDrops(t *testing.T) {
	rec := &recorder{}
	m := newManager(rec, emitN(25, true, nil), nil, nil, func(c *Config) { c.BatchInterval = time.Hour; c.BufferSize = 10 })
	m.Start(context.Background(), protocol.LogStart{StreamID: "d", Source: "kernel"})
	time.Sleep(30 * time.Millisecond)
	m.Stop("d")
	waitFor(t, func() bool { return rec.end("d") != nil })
	lines, dropped, _ := rec.logs("d")
	if len(lines) != 10 || dropped != 15 || lines[0].Message != "line 15" {
		t.Errorf("lines=%d dropped=%d first=%q", len(lines), dropped, lines[0].Message)
	}
	if e := rec.end("d"); e.Reason != protocol.LogEndStopped {
		t.Errorf("end %+v", e)
	}
}

func TestTooManyStreamsAndReplace(t *testing.T) {
	rec := &recorder{}
	m := newManager(rec, emitN(1, true, nil), nil, nil, func(c *Config) { c.MaxStreams = 2 })
	ctx := context.Background()
	m.Start(ctx, protocol.LogStart{StreamID: "a", Source: "journal"})
	m.Start(ctx, protocol.LogStart{StreamID: "b", Source: "journal"})
	m.Start(ctx, protocol.LogStart{StreamID: "c", Source: "journal"})
	waitFor(t, func() bool { return rec.end("c") != nil })
	if e := rec.end("c"); e.Reason != protocol.LogEndError || e.Message != "too many streams" {
		t.Errorf("end %+v", e)
	}
	if m.Count() != 2 {
		t.Errorf("count %d", m.Count())
	}
	// Same id again replaces the stream: the old one ends "stopped", the new one runs.
	m.Start(ctx, protocol.LogStart{StreamID: "a", Source: "journal"})
	waitFor(t, func() bool { return rec.end("a") != nil })
	if e := rec.end("a"); e.Reason != protocol.LogEndStopped {
		t.Errorf("replaced stream end %+v", e)
	}
	if m.Count() != 2 {
		t.Errorf("count after replace %d", m.Count())
	}
	m.StopAll()
	if m.Count() != 0 {
		t.Errorf("count after StopAll %d", m.Count())
	}
	rec.mu.Lock()
	ends := 0
	for _, msg := range rec.msgs {
		if e, ok := msg.(*protocol.LogEnd); ok && e.Reason == protocol.LogEndStopped {
			ends++
		}
	}
	rec.mu.Unlock()
	if ends != 3 {
		t.Errorf("%d stopped ends, want 3 (replaced a, then a and b)", ends)
	}
}

func TestUnavailableAndErrors(t *testing.T) {
	rec := &recorder{}
	journalOp := func(ctx context.Context, req protocol.LogStart, out chan<- protocol.LogLine) error {
		return journal.ErrUnavailable
	}
	webOp := func(ctx context.Context, req protocol.LogStart, out chan<- protocol.LogLine) error {
		return fmt.Errorf("%w: no nginx here", ErrUnavailable)
	}
	containerOp := func(ctx context.Context, req protocol.LogStart, out chan<- protocol.LogLine) error {
		return errors.New("No such container: x")
	}
	m := newManager(rec, journalOp, webOp, containerOp, nil)
	ctx := context.Background()
	m.Start(ctx, protocol.LogStart{StreamID: "j", Source: "journal"})
	m.Start(ctx, protocol.LogStart{StreamID: "w", Source: "web"})
	m.Start(ctx, protocol.LogStart{StreamID: "c", Source: "container", Container: "x"})
	m.Start(ctx, protocol.LogStart{StreamID: "f", Source: "file", Path: "/var/log/syslog"})
	m.Start(ctx, protocol.LogStart{StreamID: "u", Source: "bogus"})
	waitFor(t, func() bool {
		return rec.end("j") != nil && rec.end("w") != nil && rec.end("c") != nil && rec.end("f") != nil && rec.end("u") != nil
	})
	if e := rec.end("j"); e.Reason != protocol.LogEndUnavailable {
		t.Errorf("journal %+v", e)
	}
	if e := rec.end("w"); e.Reason != protocol.LogEndUnavailable || e.Message == "" {
		t.Errorf("web %+v", e)
	}
	if e := rec.end("c"); e.Reason != protocol.LogEndError || e.Message != "No such container: x" {
		t.Errorf("container %+v", e)
	}
	if e := rec.end("f"); e.Reason != protocol.LogEndUnavailable {
		t.Errorf("file %+v", e)
	}
	if e := rec.end("u"); e.Reason != protocol.LogEndUnavailable {
		t.Errorf("bogus %+v", e)
	}
	// Nil openers are unavailable too.
	m2 := newManager(rec, nil, nil, nil, nil)
	m2.Start(ctx, protocol.LogStart{StreamID: "n", Source: "container", Container: "x"})
	waitFor(t, func() bool { return rec.end("n") != nil })
	if e := rec.end("n"); e.Reason != protocol.LogEndUnavailable {
		t.Errorf("nil opener %+v", e)
	}
}

func TestConnectionContextStopsStreams(t *testing.T) {
	rec := &recorder{}
	var gotTail int
	var mu sync.Mutex
	op := func(ctx context.Context, req protocol.LogStart, out chan<- protocol.LogLine) error {
		mu.Lock()
		gotTail = req.Tail
		mu.Unlock()
		<-ctx.Done()
		return ctx.Err()
	}
	m := newManager(rec, op, nil, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	m.Start(ctx, protocol.LogStart{StreamID: "x", Source: "journal"})
	waitFor(t, func() bool { mu.Lock(); defer mu.Unlock(); return gotTail == 200 })
	cancel()
	waitFor(t, func() bool { return rec.end("x") != nil && m.Count() == 0 })
	if e := rec.end("x"); e.Reason != protocol.LogEndStopped {
		t.Errorf("end %+v", e)
	}
}
