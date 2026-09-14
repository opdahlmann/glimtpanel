// Package health runs a container node's own checks (fase 12): GET of the
// health URL and TCP reachability of the targets in GLIMT_CHECKS, both once
// per snapshot.
package health

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// Target is one name=host:port pair from GLIMT_CHECKS.
type Target struct {
	Name string
	Addr string
}

// ParseChecks parses "db=postgres:5432,cache=redis:6379". A bare "host:port"
// gets its host as the name. Empty input gives nil.
func ParseChecks(s string) ([]Target, error) {
	var out []Target
	for _, item := range strings.Split(s, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		name, addr, ok := strings.Cut(item, "=")
		if !ok {
			addr = name
			name, _, _ = strings.Cut(addr, ":")
		}
		name, addr = strings.TrimSpace(name), strings.TrimSpace(addr)
		if _, _, err := net.SplitHostPort(addr); err != nil {
			return nil, fmt.Errorf("GLIMT_CHECKS: %q is not name=host:port", item)
		}
		if name == "" {
			return nil, fmt.Errorf("GLIMT_CHECKS: %q has no name", item)
		}
		out = append(out, Target{Name: name, Addr: addr})
	}
	return out, nil
}

// Checker runs the checks. Zero values use the defaults from the plan:
// 3 s for the URL, 2 s per TCP target, no redirects.
type Checker struct {
	URL         string
	Targets     []Target
	HTTPTimeout time.Duration
	TCPTimeout  time.Duration
	Now         func() time.Time
	Dial        func(ctx context.Context, network, addr string) (net.Conn, error)
	client      *http.Client
}

// Enabled reports whether there is anything to check.
func (c *Checker) Enabled() bool { return c != nil && (c.URL != "" || len(c.Targets) > 0) }

func (c *Checker) init() {
	if c.HTTPTimeout <= 0 {
		c.HTTPTimeout = 3 * time.Second
	}
	if c.TCPTimeout <= 0 {
		c.TCPTimeout = 2 * time.Second
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Dial == nil {
		c.Dial = (&net.Dialer{}).DialContext
	}
	if c.client == nil {
		c.client = &http.Client{
			Timeout: c.HTTPTimeout,
			// Only the app's own answer counts; a 3xx is reported as it is.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
			Transport:     &http.Transport{DisableKeepAlives: true, Proxy: nil},
		}
	}
}

// Run performs the checks and returns the snapshot sections (nil when not configured).
func (c *Checker) Run(ctx context.Context) (*protocol.Health, []protocol.Check) {
	if !c.Enabled() {
		return nil, nil
	}
	c.init()
	var health *protocol.Health
	if c.URL != "" {
		health = c.checkURL(ctx)
	}
	var checks []protocol.Check
	for _, t := range c.Targets {
		checks = append(checks, c.checkTCP(ctx, t))
	}
	return health, checks
}

func (c *Checker) checkURL(ctx context.Context) *protocol.Health {
	h := &protocol.Health{URL: c.URL, CheckedAt: c.Now().UnixMilli()}
	rctx, cancel := context.WithTimeout(ctx, c.HTTPTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodGet, c.URL, nil)
	if err != nil {
		h.Error = err.Error()
		return h
	}
	req.Header.Set("User-Agent", "glimt-agent-health")
	start := c.Now()
	resp, err := c.client.Do(req)
	h.Ms = c.Now().Sub(start).Milliseconds()
	if err != nil {
		h.Error = shortErr(err)
		return h
	}
	defer resp.Body.Close()
	h.Status = resp.StatusCode
	h.OK = resp.StatusCode >= 200 && resp.StatusCode < 300
	if !h.OK {
		h.Error = resp.Status
	}
	return h
}

func (c *Checker) checkTCP(ctx context.Context, t Target) protocol.Check {
	out := protocol.Check{Name: t.Name, Target: t.Addr}
	dctx, cancel := context.WithTimeout(ctx, c.TCPTimeout)
	defer cancel()
	start := c.Now()
	conn, err := c.Dial(dctx, "tcp", t.Addr)
	out.Ms = c.Now().Sub(start).Milliseconds()
	if err != nil {
		out.Error = shortErr(err)
		return out
	}
	conn.Close()
	out.OK = true
	return out
}

// shortErr strips the Go wrapping so "dial tcp 10.0.0.5:5432: i/o timeout"
// becomes what a person would write.
func shortErr(err error) string {
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "timeout"
	}
	s := err.Error()
	if i := strings.LastIndex(s, ": "); i >= 0 && i+2 < len(s) {
		s = s[i+2:]
	}
	if len(s) > 80 {
		s = s[:80]
	}
	return s
}
