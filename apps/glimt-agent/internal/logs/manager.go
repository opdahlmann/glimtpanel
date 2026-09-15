// Package logs runs the log streams a connection asked for: it routes each
// logStart to journald, the web server log files or Docker, batches the
// lines into log messages, bounds memory per stream and ends every stream
// with logEnd.
package logs

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/journal"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// ErrUnavailable from an Opener ends the stream with reason "unavailable".
// journal.ErrUnavailable is treated the same way.
var ErrUnavailable = errors.New("logs: source unavailable")

// Sink receives outbound messages (the WebSocket send queue).
type Sink = protocol.Sender

// Opener streams lines for a request into out until ctx ends (return
// ctx.Err()), the source is exhausted (return nil) or it fails.
type Opener func(ctx context.Context, req protocol.LogStart, out chan<- protocol.LogLine) error

// Config for a Manager.
type Config struct {
	Sink      Sink
	Journal   Opener // journal, auth, kernel, packages, firewall; nil = unavailable
	Web       Opener // web; nil = unavailable
	Container Opener // container; nil = unavailable
	File      Opener // file (fase 12, paths under GLIMT_LOG_PATHS); nil = unavailable
	Logger    *slog.Logger

	MaxStreams    int           // default 8
	BatchInterval time.Duration // default 100 ms
	MaxBatch      int           // lines per log message, default 200
	BufferSize    int           // lines kept per stream between batches, default 1000
	DefaultTail   int           // when logStart.tail is absent, default 200
}

// Manager owns the streams of one connection.
type Manager struct {
	cfg Config
	log *slog.Logger

	mu      sync.Mutex
	streams map[string]*stream
}

type stream struct {
	id     string
	cancel context.CancelFunc
	done   chan struct{}

	mu      sync.Mutex
	buf     []protocol.LogLine
	dropped int
}

// New builds a Manager with defaults applied.
func New(cfg Config) *Manager {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.MaxStreams <= 0 {
		cfg.MaxStreams = 8
	}
	if cfg.BatchInterval <= 0 {
		cfg.BatchInterval = 100 * time.Millisecond
	}
	if cfg.MaxBatch <= 0 {
		cfg.MaxBatch = 200
	}
	if cfg.BufferSize <= 0 {
		cfg.BufferSize = 1000
	}
	if cfg.DefaultTail <= 0 {
		cfg.DefaultTail = 200
	}
	return &Manager{cfg: cfg, log: cfg.Logger, streams: map[string]*stream{}}
}

// Count returns the number of live streams.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.streams)
}

// Start opens a stream. A second logStart with the same streamId replaces
// the first. ctx bounds the stream (the connection); StopAll ends it too.
func (m *Manager) Start(ctx context.Context, req protocol.LogStart) {
	if req.Tail <= 0 {
		req.Tail = m.cfg.DefaultTail
	}
	opener := m.route(req.Source)

	m.mu.Lock()
	if old, ok := m.streams[req.StreamID]; ok {
		delete(m.streams, req.StreamID)
		m.mu.Unlock()
		old.cancel()
		<-old.done
		m.mu.Lock()
	}
	if len(m.streams) >= m.cfg.MaxStreams {
		m.mu.Unlock()
		m.log.Warn("logStart refused: too many streams", "streamId", req.StreamID, "max", m.cfg.MaxStreams)
		m.cfg.Sink.Send(&protocol.LogEnd{StreamID: req.StreamID, Reason: protocol.LogEndError, Message: "too many streams"})
		return
	}
	if opener == nil {
		m.mu.Unlock()
		m.cfg.Sink.Send(&protocol.LogEnd{StreamID: req.StreamID, Reason: protocol.LogEndUnavailable, Message: fmt.Sprintf("source %q is not available on this server", req.Source)})
		return
	}
	sctx, cancel := context.WithCancel(ctx)
	st := &stream{id: req.StreamID, cancel: cancel, done: make(chan struct{})}
	m.streams[req.StreamID] = st
	m.mu.Unlock()
	m.log.Info("log stream started", "streamId", req.StreamID, "source", req.Source, "unit", req.Unit, "container", req.Container, "tail", req.Tail)
	go m.run(sctx, st, opener, req)
}

// Stop ends one stream; logEnd "stopped" follows asynchronously.
func (m *Manager) Stop(streamID string) {
	m.mu.Lock()
	st, ok := m.streams[streamID]
	m.mu.Unlock()
	if ok {
		st.cancel()
	}
}

// StopAll ends every stream and waits for them to finish.
func (m *Manager) StopAll() {
	m.mu.Lock()
	all := make([]*stream, 0, len(m.streams))
	for _, st := range m.streams {
		all = append(all, st)
	}
	m.mu.Unlock()
	for _, st := range all {
		st.cancel()
	}
	for _, st := range all {
		<-st.done
	}
}

func (m *Manager) route(source string) Opener {
	switch source {
	case journal.SourceJournal, journal.SourceAuth, journal.SourceKernel, journal.SourcePackages, journal.SourceFirewall:
		return m.cfg.Journal
	case journal.SourceWeb:
		return m.cfg.Web
	case "container":
		return m.cfg.Container
	case "file":
		return m.cfg.File
	}
	return nil
}

// run pumps lines from the opener into the buffer and flushes batches.
func (m *Manager) run(ctx context.Context, st *stream, opener Opener, req protocol.LogStart) {
	defer close(st.done)
	defer func() {
		m.mu.Lock()
		if m.streams[st.id] == st {
			delete(m.streams, st.id)
		}
		m.mu.Unlock()
	}()

	raw := make(chan protocol.LogLine, 64)
	result := make(chan error, 1)
	go func() {
		err := opener(ctx, req, raw)
		close(raw)
		result <- err
	}()

	ticker := time.NewTicker(m.cfg.BatchInterval)
	defer ticker.Stop()
	for raw != nil {
		select {
		case line, ok := <-raw:
			if !ok {
				raw = nil
				continue
			}
			st.push(line, m.cfg.BufferSize)
		case <-ticker.C:
			m.flush(st, false)
		}
	}
	err := <-result
	m.flush(st, true)

	end := &protocol.LogEnd{StreamID: st.id, Reason: protocol.LogEndEOF}
	switch {
	case ctx.Err() != nil:
		end.Reason = protocol.LogEndStopped
	case err == nil:
	case errors.Is(err, ErrUnavailable), errors.Is(err, journal.ErrUnavailable):
		end.Reason, end.Message = protocol.LogEndUnavailable, err.Error()
	default:
		end.Reason, end.Message = protocol.LogEndError, err.Error()
	}
	m.log.Info("log stream ended", "streamId", st.id, "reason", end.Reason, "message", end.Message)
	m.cfg.Sink.Send(end)
}

// push appends a line, dropping the oldest when the buffer is full.
func (st *stream) push(line protocol.LogLine, max int) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.buf) >= max {
		st.buf = st.buf[1:]
		st.dropped++
	}
	st.buf = append(st.buf, line)
}

// flush sends one batch (or, with all, every batch) of buffered lines.
func (m *Manager) flush(st *stream, all bool) {
	for {
		st.mu.Lock()
		if len(st.buf) == 0 {
			st.mu.Unlock()
			return
		}
		n := len(st.buf)
		if n > m.cfg.MaxBatch {
			n = m.cfg.MaxBatch
		}
		msg := &protocol.Log{StreamID: st.id, Lines: append([]protocol.LogLine(nil), st.buf[:n]...), Dropped: st.dropped}
		st.buf = append(st.buf[:0], st.buf[n:]...)
		st.dropped = 0
		st.mu.Unlock()
		m.cfg.Sink.Send(msg)
		if !all {
			return
		}
	}
}
