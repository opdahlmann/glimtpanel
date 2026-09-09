// Package ws is the agent's WebSocket client: dial, hello/welcome, ping/pong,
// token rotation, subscribe/unsubscribe, a bounded send queue and reconnect
// with exponential backoff.
package ws

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// TokenStore persists the long-lived token (internal/state.Store).
type TokenStore interface {
	Load() (string, error)
	Save(string) error
	Clear() error
}

// Sender is the outbound queue handed to the session.
type Sender interface {
	// Send queues a message. Stream and log messages are dropped when the
	// queue is full; everything else (snapshot, logEnd, pong) waits.
	// Returns false if not queued.
	Send(protocol.Message) bool
}

// Session is what a connection drives after welcome: the scheduler and the
// log stream manager. It ends with the context given to NewSession.
type Session interface {
	Subscribe(interval time.Duration, topProcs int)
	Unsubscribe()
	LogStart(req protocol.LogStart)
	LogStop(streamID string)
}

// Config for the client.
type Config struct {
	HubURL   string
	EnrolKey string
	Store    TokenStore
	// Hello returns the static part of hello; the client fills v, enrolKey/token.
	Hello func() protocol.Hello
	// NewSession is called once per connection after welcome. ctx ends with
	// the connection. May be nil (no snapshots are then sent).
	NewSession func(ctx context.Context, w *protocol.Welcome, out Sender) Session

	AuthFailedBackoff time.Duration // default 1 h
	Backoff           *Backoff      // default 1 s → 60 s + 0–10 s
	Logger            *slog.Logger
	UserAgent         string

	MaxFrameBytes int64         // default 1 MiB
	QueueSize     int           // default 64
	DialTimeout   time.Duration // default 15 s
	WriteTimeout  time.Duration // default 15 s
	// ReadTimeout closes a connection with no inbound traffic; the hub pings
	// every 30 s. Default 2 min.
	ReadTimeout time.Duration
	// DropLogInterval controls how often dropped stream messages are logged. Default 1 min.
	DropLogInterval time.Duration
	// CloseGrace is how long a clean close handshake may take at shutdown
	// before the socket is simply closed. Default 2 s.
	CloseGrace time.Duration
}

// Client connects to the hub and keeps reconnecting until its context ends.
type Client struct {
	cfg Config
	log *slog.Logger
}

// New validates the config and applies defaults.
func New(cfg Config) (*Client, error) {
	if !strings.HasPrefix(cfg.HubURL, "ws://") && !strings.HasPrefix(cfg.HubURL, "wss://") {
		return nil, fmt.Errorf("ws: hub URL must start with ws:// or wss://, got %q", cfg.HubURL)
	}
	if cfg.Store == nil {
		return nil, errors.New("ws: Store is required")
	}
	if cfg.Hello == nil {
		return nil, errors.New("ws: Hello is required")
	}
	if cfg.AuthFailedBackoff <= 0 {
		cfg.AuthFailedBackoff = time.Hour
	}
	if cfg.Backoff == nil {
		cfg.Backoff = NewBackoff(nil)
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.MaxFrameBytes <= 0 {
		cfg.MaxFrameBytes = 1 << 20
	}
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = 64
	}
	if cfg.DialTimeout <= 0 {
		cfg.DialTimeout = 15 * time.Second
	}
	if cfg.WriteTimeout <= 0 {
		cfg.WriteTimeout = 15 * time.Second
	}
	if cfg.ReadTimeout <= 0 {
		cfg.ReadTimeout = 2 * time.Minute
	}
	if cfg.DropLogInterval <= 0 {
		cfg.DropLogInterval = time.Minute
	}
	if cfg.CloseGrace <= 0 {
		cfg.CloseGrace = 2 * time.Second
	}
	if cfg.UserAgent == "" {
		cfg.UserAgent = "glimt-agent"
	}
	return &Client{cfg: cfg, log: cfg.Logger}, nil
}

// Run blocks until ctx is done, reconnecting with backoff in between.
func (c *Client) Run(ctx context.Context) error {
	for {
		res := c.connectOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		var wait time.Duration
		if res.authFailed {
			wait = c.cfg.AuthFailedBackoff
			c.cfg.Backoff.Reset()
			c.log.Warn("authentication failed; waiting before retrying", "wait", wait,
				"hint", "run `sudo glimt-agent uninstall` if this server was removed from Glimtpanel")
		} else {
			if res.welcomed {
				c.cfg.Backoff.Reset()
			}
			wait = c.cfg.Backoff.Next()
			c.log.Info("reconnecting", "in", wait.Round(time.Millisecond))
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
	}
}

type outcome struct {
	welcomed   bool
	authFailed bool
}

// rawConn remembers the TCP connection under the WebSocket so shutdown can
// cut it when the hub does not answer the close handshake.
type rawConn struct {
	mu sync.Mutex
	c  net.Conn
}

func (r *rawConn) set(c net.Conn) {
	r.mu.Lock()
	r.c = c
	r.mu.Unlock()
}

func (r *rawConn) close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.c != nil {
		_ = r.c.Close()
	}
}

// dial opens the WebSocket with its own transport: HTTP/1.1 only, TLS 1.2+,
// proxy from the environment, and the raw connection captured.
func (c *Client) dial(ctx context.Context) (*websocket.Conn, *rawConn, error) {
	raw := &rawConn{}
	d := &net.Dialer{Timeout: c.cfg.DialTimeout, KeepAlive: 30 * time.Second}
	tr := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			nc, err := d.DialContext(ctx, network, addr)
			if err == nil {
				raw.set(nc)
			}
			return nc, err
		},
		TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout: c.cfg.DialTimeout,
	}
	dialCtx, cancel := context.WithTimeout(ctx, c.cfg.DialTimeout)
	defer cancel()
	conn, _, err := websocket.Dial(dialCtx, c.cfg.HubURL, &websocket.DialOptions{
		HTTPClient: &http.Client{Transport: tr},
		HTTPHeader: http.Header{"User-Agent": []string{c.cfg.UserAgent}},
	})
	if err != nil {
		tr.CloseIdleConnections()
		return nil, nil, err
	}
	return conn, raw, nil
}

var errAuthFailed = errors.New("auth failed")

func (c *Client) connectOnce(ctx context.Context) outcome {
	token, err := c.cfg.Store.Load()
	if err != nil {
		c.log.Error("cannot read token", "err", err)
	}
	if token == "" && c.cfg.EnrolKey == "" {
		c.log.Error("no token stored and no enrol key configured; cannot authenticate")
		return outcome{}
	}

	conn, raw, err := c.dial(ctx)
	if err != nil {
		if ctx.Err() == nil {
			c.log.Warn("connect failed", "hub", c.cfg.HubURL, "err", err)
		}
		return outcome{}
	}
	conn.SetReadLimit(c.cfg.MaxFrameBytes)
	c.log.Info("connected", "hub", c.cfg.HubURL, "auth", map[bool]string{true: "token", false: "enrolKey"}[token != ""])

	// internalCtx ends when this connection is torn down for any reason;
	// sessCtx additionally ends when the agent stops.
	internalCtx, cancelInternal := context.WithCancel(context.Background())
	defer cancelInternal()
	sessCtx, cancelSess := context.WithCancel(ctx)
	defer cancelSess()
	defer conn.CloseNow()

	go func() {
		select {
		case <-ctx.Done():
			// Try a clean close so the hub sees a normal closure. The handshake
			// completes when the hub echoes the close frame (our read loop
			// receives it); if that does not happen within CloseGrace, cancel
			// the read context, which makes the library close the socket.
			go func() { _ = conn.Close(websocket.StatusNormalClosure, "agent stopping") }()
			select {
			case <-internalCtx.Done():
			case <-time.After(c.cfg.CloseGrace):
				raw.close()
				cancelInternal()
			}
		case <-internalCtx.Done():
		}
	}()

	s := &session{
		client: c,
		conn:   conn,
		out:    make(chan []byte, c.cfg.QueueSize),
		ctx:    sessCtx,
		fail:   func() { cancelSess(); conn.CloseNow() },
	}
	go s.writeLoop()

	hello := c.cfg.Hello()
	hello.V = protocol.Version
	hello.EnrolKey, hello.Token = "", ""
	if token != "" {
		hello.Token = token
	} else {
		hello.EnrolKey = c.cfg.EnrolKey
	}
	if !s.Send(&hello) {
		return outcome{}
	}

	res, err := c.readLoop(internalCtx, sessCtx, s)
	switch {
	case ctx.Err() != nil:
		c.log.Info("disconnected (agent stopping)")
	case errors.Is(err, errAuthFailed):
	case err != nil:
		c.log.Warn("disconnected", "err", err)
	}
	return res
}

// readLoop handles inbound messages until the connection ends.
func (c *Client) readLoop(internalCtx, sessCtx context.Context, s *session) (outcome, error) {
	var res outcome
	var sess Session
	var sessMu sync.Mutex
	for {
		rctx, cancel := context.WithTimeout(internalCtx, c.cfg.ReadTimeout)
		typ, data, err := s.conn.Read(rctx)
		cancel()
		if err != nil {
			if errors.Is(rctx.Err(), context.DeadlineExceeded) {
				err = fmt.Errorf("no traffic from hub for %v", c.cfg.ReadTimeout)
			}
			return res, err
		}
		if typ != websocket.MessageText {
			c.log.Debug("ignoring binary frame", "bytes", len(data))
			continue
		}
		msg, err := protocol.Decode(data)
		if err != nil {
			c.log.Warn("invalid message from hub", "err", err)
			continue
		}
		switch m := msg.(type) {
		case *protocol.Welcome:
			if res.welcomed {
				c.log.Debug("duplicate welcome ignored")
				continue
			}
			res.welcomed = true
			if m.Token != "" {
				if err := c.cfg.Store.Save(m.Token); err != nil {
					c.log.Error("cannot store token", "err", err)
				} else {
					c.log.Info("token stored", "path", "state dir")
				}
			}
			c.log.Info("welcome", "serverId", m.ServerID, "snapshotInterval", m.SnapshotInterval, "maintenanceInterval", m.MaintenanceInterval)
			if c.cfg.NewSession != nil {
				sessMu.Lock()
				sess = c.cfg.NewSession(sessCtx, m, s)
				sessMu.Unlock()
			}
		case *protocol.AuthFailed:
			res.authFailed = true
			c.log.Error("hub rejected authentication", "reason", m.Reason)
			if (m.Reason == protocol.ReasonInvalidToken || m.Reason == protocol.ReasonServerRemoved) && c.cfg.EnrolKey != "" {
				if err := c.cfg.Store.Clear(); err != nil {
					c.log.Error("cannot clear rejected token", "err", err)
				} else {
					c.log.Warn("stored token discarded; will re-enrol with the configured key after the wait")
				}
			}
			return res, errAuthFailed
		case *protocol.Ping:
			s.Send(&protocol.Pong{})
		case *protocol.Rotate:
			if err := c.cfg.Store.Save(m.Token); err != nil {
				c.log.Error("cannot store rotated token", "err", err)
			} else {
				c.log.Info("token rotated")
			}
		case *protocol.Subscribe:
			c.log.Info("subscribe", "intervalMs", m.IntervalMs, "topProcs", m.TopProcs)
			sessMu.Lock()
			if sess != nil {
				sess.Subscribe(time.Duration(m.IntervalMs)*time.Millisecond, m.TopProcs)
			} else {
				c.log.Warn("subscribe before welcome ignored")
			}
			sessMu.Unlock()
		case *protocol.Unsubscribe:
			c.log.Info("unsubscribe")
			sessMu.Lock()
			if sess != nil {
				sess.Unsubscribe()
			}
			sessMu.Unlock()
		case *protocol.LogStart:
			sessMu.Lock()
			if sess != nil {
				sess.LogStart(*m)
			} else {
				c.log.Warn("logStart before welcome", "streamId", m.StreamID)
				s.Send(&protocol.LogEnd{StreamID: m.StreamID, Reason: protocol.LogEndError, Message: "logStart before welcome"})
			}
			sessMu.Unlock()
		case *protocol.LogStop:
			c.log.Debug("logStop", "streamId", m.StreamID)
			sessMu.Lock()
			if sess != nil {
				sess.LogStop(m.StreamID)
			}
			sessMu.Unlock()
		default:
			c.log.Warn("unexpected message from hub", "type", msg.MessageType())
		}
	}
}

// session is one live connection's outbound side.
type session struct {
	client  *Client
	conn    *websocket.Conn
	out     chan []byte
	ctx     context.Context
	fail    func()
	dropped atomic.Int64
}

// Send implements Sender.
func (s *session) Send(m protocol.Message) bool {
	data, err := protocol.Encode(m)
	if err != nil {
		s.client.log.Error("cannot encode message", "type", m.MessageType(), "err", err)
		return false
	}
	if t := m.MessageType(); t == protocol.TypeStream || t == protocol.TypeLog {
		select {
		case s.out <- data:
			return true
		default:
			s.dropped.Add(1)
			return false
		}
	}
	select {
	case s.out <- data:
		return true
	case <-s.ctx.Done():
		return false
	}
}

func (s *session) writeLoop() {
	report := time.NewTicker(s.client.cfg.DropLogInterval)
	defer report.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-report.C:
			if n := s.dropped.Swap(0); n > 0 {
				s.client.log.Warn("stream/log messages dropped (send queue full)", "count", n, "interval", s.client.cfg.DropLogInterval)
			}
		case data := <-s.out:
			wctx, cancel := context.WithTimeout(s.ctx, s.client.cfg.WriteTimeout)
			err := s.conn.Write(wctx, websocket.MessageText, data)
			cancel()
			if err != nil {
				if s.ctx.Err() == nil {
					s.client.log.Warn("write failed", "err", err)
				}
				s.fail()
				return
			}
		}
	}
}
