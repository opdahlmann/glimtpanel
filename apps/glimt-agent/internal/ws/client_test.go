package ws

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/sched"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/state"
)

// fakeHub accepts WebSocket connections and hands each to handler.
func fakeHub(t *testing.T, handler func(ctx context.Context, c *websocket.Conn)) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		handler(r.Context(), c)
	}))
	t.Cleanup(srv.Close)
	return "ws://" + strings.TrimPrefix(srv.URL, "http://")
}

func readMsg(t *testing.T, ctx context.Context, c *websocket.Conn) protocol.Message {
	t.Helper()
	rctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	_, data, err := c.Read(rctx)
	if err != nil {
		return nil
	}
	msg, err := protocol.Decode(data)
	if err != nil {
		t.Errorf("hub could not decode %s: %v", data, err)
		return nil
	}
	return msg
}

// readUntil reads until a message of the wanted type arrives (skipping others).
func readUntil(t *testing.T, ctx context.Context, c *websocket.Conn, typ string) protocol.Message {
	t.Helper()
	for {
		m := readMsg(t, ctx, c)
		if m == nil || m.MessageType() == typ {
			return m
		}
	}
}

func writeMsg(t *testing.T, ctx context.Context, c *websocket.Conn, m protocol.Message) {
	t.Helper()
	data, err := protocol.Encode(m)
	if err != nil {
		t.Fatal(err)
	}
	wctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	_ = c.Write(wctx, websocket.MessageText, data)
}

func testHello() protocol.Hello {
	return protocol.Hello{Hostname: "test-host", AgentVersion: "0.0.0-test", OS: protocol.OSInfo{ID: "ubuntu", VersionID: "24.04", PrettyName: "Ubuntu 24.04"},
		Kernel: "6.8", Arch: "arm64", Cores: 2, RAMBytes: 1 << 30, BootTime: 1, DockerMode: protocol.DockerNone}
}

func newTestClient(t *testing.T, url string, store *state.Store, extra func(*Config)) *Client {
	t.Helper()
	cfg := Config{
		HubURL:            url,
		EnrolKey:          "gp_test",
		Store:             store,
		Hello:             testHello,
		AuthFailedBackoff: 50 * time.Millisecond,
		Backoff:           NewBackoffWith(5*time.Millisecond, 10*time.Millisecond, 0, nil),
		ReadTimeout:       5 * time.Second,
		CloseGrace:        50 * time.Millisecond,
	}
	if extra != nil {
		extra(&cfg)
	}
	c, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func runClient(t *testing.T, c *Client) (cancel func()) {
	t.Helper()
	ctx, cancelCtx := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = c.Run(ctx); close(done) }()
	return func() {
		cancelCtx()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("client did not stop")
		}
	}
}

func TestNewRejectsBadConfig(t *testing.T) {
	if _, err := New(Config{HubURL: "http://x", Store: state.New(t.TempDir()), Hello: testHello}); err == nil {
		t.Error("http:// must be rejected")
	}
	if _, err := New(Config{HubURL: "ws://x", Hello: testHello}); err == nil {
		t.Error("missing store must be rejected")
	}
}

func TestEnrolStoresTokenAndReconnectsWithIt(t *testing.T) {
	hellos := make(chan *protocol.Hello, 4)
	url := fakeHub(t, func(ctx context.Context, c *websocket.Conn) {
		m := readMsg(t, ctx, c)
		h, ok := m.(*protocol.Hello)
		if !ok {
			return
		}
		hellos <- h
		w := &protocol.Welcome{ServerID: "srv1", SnapshotInterval: 30000, MaintenanceInterval: 600000}
		if h.Token == "" {
			w.Token = "agt_c0ffee1234567890abcdef"
		}
		writeMsg(t, ctx, c, w)
		time.Sleep(20 * time.Millisecond)
		_ = c.Close(websocket.StatusNormalClosure, "bye")
	})
	store := state.New(t.TempDir())
	stop := runClient(t, newTestClient(t, url, store, nil))
	defer stop()

	h1 := <-hellos
	if h1.EnrolKey != "gp_test" || h1.Token != "" || h1.V != 1 || h1.Hostname != "test-host" {
		t.Errorf("first hello = %+v", h1)
	}
	select {
	case h2 := <-hellos:
		if h2.Token != "agt_c0ffee1234567890abcdef" || h2.EnrolKey != "" {
			t.Errorf("second hello should carry the token: %+v", h2)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("client did not reconnect")
	}
	if tok, _ := store.Load(); tok != "agt_c0ffee1234567890abcdef" {
		t.Errorf("token not persisted: %q", tok)
	}
}

func TestPingPong(t *testing.T) {
	gotPong := make(chan struct{}, 1)
	url := fakeHub(t, func(ctx context.Context, c *websocket.Conn) {
		if _, ok := readMsg(t, ctx, c).(*protocol.Hello); !ok {
			return
		}
		writeMsg(t, ctx, c, &protocol.Welcome{ServerID: "srv1", SnapshotInterval: 30000, MaintenanceInterval: 600000})
		writeMsg(t, ctx, c, &protocol.Ping{})
		if _, ok := readUntil(t, ctx, c, protocol.TypePong).(*protocol.Pong); ok {
			gotPong <- struct{}{}
		}
		<-ctx.Done()
	})
	stop := runClient(t, newTestClient(t, url, state.New(t.TempDir()), nil))
	defer stop()
	select {
	case <-gotPong:
	case <-time.After(3 * time.Second):
		t.Fatal("no pong")
	}
}

func TestAuthFailedWaitsBeforeRedial(t *testing.T) {
	var mu sync.Mutex
	var times []time.Time
	url := fakeHub(t, func(ctx context.Context, c *websocket.Conn) {
		if _, ok := readMsg(t, ctx, c).(*protocol.Hello); !ok {
			return
		}
		mu.Lock()
		times = append(times, time.Now())
		n := len(times)
		mu.Unlock()
		if n == 1 {
			writeMsg(t, ctx, c, &protocol.AuthFailed{Reason: protocol.ReasonInvalidKey})
			return
		}
		writeMsg(t, ctx, c, &protocol.Welcome{ServerID: "srv1", SnapshotInterval: 30000, MaintenanceInterval: 600000})
		<-ctx.Done()
	})
	// Normal backoff is 1–2 ms so only AuthFailedBackoff (50 ms) can explain a longer gap.
	stop := runClient(t, newTestClient(t, url, state.New(t.TempDir()), func(cfg *Config) {
		cfg.Backoff = NewBackoffWith(time.Millisecond, 2*time.Millisecond, 0, nil)
	}))
	defer stop()

	deadline := time.Now().Add(3 * time.Second)
	for {
		mu.Lock()
		n := len(times)
		mu.Unlock()
		if n >= 2 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(times) < 2 {
		t.Fatal("client did not redial after authFailed")
	}
	if gap := times[1].Sub(times[0]); gap < 50*time.Millisecond {
		t.Errorf("redialled after %v, want >= 50ms", gap)
	}
}

func TestInvalidTokenClearsStoreWhenKeyConfigured(t *testing.T) {
	hellos := make(chan *protocol.Hello, 4)
	url := fakeHub(t, func(ctx context.Context, c *websocket.Conn) {
		h, ok := readMsg(t, ctx, c).(*protocol.Hello)
		if !ok {
			return
		}
		hellos <- h
		if h.Token != "" {
			writeMsg(t, ctx, c, &protocol.AuthFailed{Reason: protocol.ReasonInvalidToken})
			return
		}
		writeMsg(t, ctx, c, &protocol.Welcome{ServerID: "srv1", SnapshotInterval: 30000, MaintenanceInterval: 600000})
		<-ctx.Done()
	})
	store := state.New(t.TempDir())
	if err := store.Save("agt_stale_token_0123456789"); err != nil {
		t.Fatal(err)
	}
	stop := runClient(t, newTestClient(t, url, store, nil))
	defer stop()
	if h := <-hellos; h.Token == "" {
		t.Fatal("first hello should use the stored token")
	}
	select {
	case h := <-hellos:
		if h.EnrolKey != "gp_test" || h.Token != "" {
			t.Errorf("after invalidToken the agent should re-enrol: %+v", h)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no re-enrol")
	}
}

type fakeSystem struct{}

func (fakeSystem) Host(context.Context) (protocol.Host, error) {
	return protocol.Host{CPU: protocol.CPU{Total: 1}, Mem: protocol.Mem{Total: 3, Used: 1, Free: 2}}, nil
}
func (fakeSystem) Processes(context.Context, int) ([]protocol.Process, protocol.ProcessTotals, error) {
	return nil, protocol.ProcessTotals{}, nil
}
func (fakeSystem) Services(context.Context) (*protocol.Services, error)       { return nil, nil }
func (fakeSystem) Maintenance(context.Context) (*protocol.Maintenance, error) { return nil, nil }
func (fakeSystem) Security(context.Context) (*protocol.Security, error)       { return nil, nil }

// scaled shrinks the subscribe interval so the test runs fast (1000 ms → 10 ms).
type scaled struct{ s *sched.Scheduler }

func (x scaled) Subscribe(d time.Duration, top int) { x.s.Subscribe(d/100, top) }
func (x scaled) Unsubscribe()                       { x.s.Unsubscribe() }
func (x scaled) LogStart(protocol.LogStart)         {}
func (x scaled) LogStop(string)                     {}

func TestSubscribeStreamsUntilUnsubscribe(t *testing.T) {
	type event struct {
		typ string
		at  time.Time
	}
	var mu sync.Mutex
	var events []event
	var unsubAt time.Time
	done := make(chan struct{})
	url := fakeHub(t, func(ctx context.Context, c *websocket.Conn) {
		if _, ok := readMsg(t, ctx, c).(*protocol.Hello); !ok {
			return
		}
		writeMsg(t, ctx, c, &protocol.Welcome{ServerID: "srv1", SnapshotInterval: 30000, MaintenanceInterval: 600000})
		writeMsg(t, ctx, c, &protocol.Subscribe{IntervalMs: 1000, TopProcs: 40})
		streams := 0
		for streams < 3 {
			m := readMsg(t, ctx, c)
			if m == nil {
				return
			}
			mu.Lock()
			events = append(events, event{m.MessageType(), time.Now()})
			mu.Unlock()
			if m.MessageType() == protocol.TypeStream {
				streams++
			}
		}
		writeMsg(t, ctx, c, &protocol.Unsubscribe{})
		mu.Lock()
		unsubAt = time.Now()
		mu.Unlock()
		// Keep reading for a while to see whether streams stop.
		stopAt := time.Now().Add(150 * time.Millisecond)
		for time.Now().Before(stopAt) {
			rctx, cancel := context.WithDeadline(ctx, stopAt)
			_, data, err := c.Read(rctx)
			cancel()
			if err != nil {
				break
			}
			if m, err := protocol.Decode(data); err == nil {
				mu.Lock()
				events = append(events, event{m.MessageType(), time.Now()})
				mu.Unlock()
			}
		}
		close(done)
	})
	stop := runClient(t, newTestClient(t, url, state.New(t.TempDir()), func(cfg *Config) {
		cfg.NewSession = func(ctx context.Context, w *protocol.Welcome, out Sender) Session {
			s := sched.New(sched.Config{SnapshotInterval: time.Hour, MaintenanceInterval: time.Hour, System: fakeSystem{}, Sink: out})
			go s.Run(ctx)
			return scaled{s}
		}
	}))
	defer stop()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("hub side did not finish")
	}
	mu.Lock()
	defer mu.Unlock()
	snapshots, before, after := 0, 0, 0
	for _, e := range events {
		switch e.typ {
		case protocol.TypeSnapshot:
			snapshots++
		case protocol.TypeStream:
			// Allow one in-flight stream right after unsubscribe.
			if e.at.Before(unsubAt.Add(30 * time.Millisecond)) {
				before++
			} else {
				after++
			}
		}
	}
	if snapshots < 1 {
		t.Error("no snapshot after welcome")
	}
	if before < 3 {
		t.Errorf("only %d streams while subscribed", before)
	}
	if after != 0 {
		t.Errorf("%d streams arrived after unsubscribe", after)
	}
	s := events[0]
	if s.typ != protocol.TypeSnapshot {
		t.Errorf("first message after welcome should be snapshot, got %s", s.typ)
	}
}

func TestStreamDroppedWhenQueueFullButSnapshotWaits(t *testing.T) {
	// No writer running: the queue fills up and Send must not block for streams.
	s := &session{client: &Client{cfg: Config{QueueSize: 2}, log: discardLogger()}, out: make(chan []byte, 2), ctx: context.Background()}
	stream := &protocol.Stream{Host: protocol.Host{}}
	if !s.Send(stream) || !s.Send(stream) {
		t.Fatal("first two streams should queue")
	}
	if s.Send(stream) {
		t.Error("third stream should be dropped")
	}
	if s.dropped.Load() != 1 {
		t.Errorf("dropped = %d", s.dropped.Load())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	s.ctx = ctx
	start := time.Now()
	if s.Send(&protocol.Snapshot{}) {
		t.Error("snapshot cannot be queued while full and must report false when the connection ends")
	}
	if time.Since(start) < 25*time.Millisecond {
		t.Error("snapshot should wait for room instead of being dropped")
	}
}

// logSession records log routing and answers each logStart with a logEnd.
type logSession struct {
	out    Sender
	mu     sync.Mutex
	starts []protocol.LogStart
	stops  []string
}

func (l *logSession) Subscribe(time.Duration, int) {}
func (l *logSession) Unsubscribe()                 {}
func (l *logSession) LogStart(req protocol.LogStart) {
	l.mu.Lock()
	l.starts = append(l.starts, req)
	l.mu.Unlock()
	l.out.Send(&protocol.Log{StreamID: req.StreamID, Lines: []protocol.LogLine{{TS: 1, Message: "hi"}}})
}
func (l *logSession) LogStop(id string) {
	l.mu.Lock()
	l.stops = append(l.stops, id)
	l.mu.Unlock()
	l.out.Send(&protocol.LogEnd{StreamID: id, Reason: protocol.LogEndStopped})
}

func TestLogStartAndStopAreRoutedToSession(t *testing.T) {
	var ls *logSession
	var lsMu sync.Mutex
	got := make(chan protocol.Message, 8)
	url := fakeHub(t, func(ctx context.Context, c *websocket.Conn) {
		if _, ok := readMsg(t, ctx, c).(*protocol.Hello); !ok {
			return
		}
		// Before welcome: refused with logEnd error.
		writeMsg(t, ctx, c, &protocol.LogStart{StreamID: "early", Source: "journal"})
		got <- readUntil(t, ctx, c, protocol.TypeLogEnd)
		writeMsg(t, ctx, c, &protocol.Welcome{ServerID: "srv1", SnapshotInterval: 30000, MaintenanceInterval: 600000})
		writeMsg(t, ctx, c, &protocol.LogStart{StreamID: "s1", Source: "container", Container: "web", Tail: 50})
		got <- readUntil(t, ctx, c, protocol.TypeLog)
		writeMsg(t, ctx, c, &protocol.LogStop{StreamID: "s1"})
		got <- readUntil(t, ctx, c, protocol.TypeLogEnd)
		<-ctx.Done()
	})
	stop := runClient(t, newTestClient(t, url, state.New(t.TempDir()), func(cfg *Config) {
		cfg.NewSession = func(ctx context.Context, w *protocol.Welcome, out Sender) Session {
			lsMu.Lock()
			defer lsMu.Unlock()
			ls = &logSession{out: out}
			return ls
		}
	}))
	defer stop()
	next := func() protocol.Message {
		select {
		case m := <-got:
			return m
		case <-time.After(3 * time.Second):
			t.Fatal("timeout")
			return nil
		}
	}
	if e, ok := next().(*protocol.LogEnd); !ok || e.StreamID != "early" || e.Reason != protocol.LogEndError {
		t.Errorf("early logStart: %+v", e)
	}
	if l, ok := next().(*protocol.Log); !ok || l.StreamID != "s1" || len(l.Lines) != 1 {
		t.Errorf("log: %+v", l)
	}
	if e, ok := next().(*protocol.LogEnd); !ok || e.StreamID != "s1" || e.Reason != protocol.LogEndStopped {
		t.Errorf("logEnd: %+v", e)
	}
	lsMu.Lock()
	defer lsMu.Unlock()
	ls.mu.Lock()
	defer ls.mu.Unlock()
	if len(ls.starts) != 1 || ls.starts[0].Container != "web" || ls.starts[0].Tail != 50 || len(ls.stops) != 1 || ls.stops[0] != "s1" {
		t.Errorf("session saw starts=%+v stops=%v", ls.starts, ls.stops)
	}
}

func TestLogDroppedWhenQueueFull(t *testing.T) {
	s := &session{client: &Client{cfg: Config{QueueSize: 1}, log: discardLogger()}, out: make(chan []byte, 1), ctx: context.Background()}
	if !s.Send(&protocol.Log{StreamID: "x"}) {
		t.Fatal("first log should queue")
	}
	if s.Send(&protocol.Log{StreamID: "x"}) {
		t.Error("second log should be dropped when the queue is full")
	}
	if s.dropped.Load() != 1 {
		t.Errorf("dropped = %d", s.dropped.Load())
	}
}

// A container node says bye before it closes at shutdown, so the hub can
// show it as sleeping instead of down (fase 12).
func TestByeOnShutdown(t *testing.T) {
	gotBye := make(chan string, 1)
	url := fakeHub(t, func(ctx context.Context, c *websocket.Conn) {
		if _, ok := readMsg(t, ctx, c).(*protocol.Hello); !ok {
			return
		}
		writeMsg(t, ctx, c, &protocol.Welcome{ServerID: "srv1", SnapshotInterval: 30000, MaintenanceInterval: 600000})
		if b, ok := readUntil(t, ctx, c, protocol.TypeBye).(*protocol.Bye); ok {
			gotBye <- b.Reason
		}
		<-ctx.Done()
	})
	store := state.New(t.TempDir())
	if err := store.Save("agt_container_token"); err != nil {
		t.Fatal(err)
	}
	stop := runClient(t, newTestClient(t, url, store, func(c *Config) { c.Bye = true; c.EnrolKey = "" }))
	time.Sleep(100 * time.Millisecond) // let welcome arrive
	stop()
	select {
	case reason := <-gotBye:
		if reason != protocol.ByeReasonShutdown {
			t.Errorf("reason = %q", reason)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("hub did not get bye before close")
	}
}

// Without Bye (the server profile) nothing is sent at shutdown.
func TestNoByeForServers(t *testing.T) {
	msgs := make(chan string, 8)
	url := fakeHub(t, func(ctx context.Context, c *websocket.Conn) {
		if _, ok := readMsg(t, ctx, c).(*protocol.Hello); !ok {
			return
		}
		writeMsg(t, ctx, c, &protocol.Welcome{ServerID: "srv1", SnapshotInterval: 30000, MaintenanceInterval: 600000})
		for {
			m := readMsg(t, ctx, c)
			if m == nil {
				close(msgs)
				return
			}
			msgs <- m.MessageType()
		}
	})
	stop := runClient(t, newTestClient(t, url, state.New(t.TempDir()), nil))
	time.Sleep(100 * time.Millisecond)
	stop()
	for typ := range msgs {
		if typ == protocol.TypeBye {
			t.Error("server profile must not send bye")
		}
	}
}
