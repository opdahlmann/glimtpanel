// Package docker talks to the Docker Engine API read-only: version
// negotiation, container list and inspect, cgroup v2 statistics, the event
// stream and container logs. It works over the local Unix socket or a TCP
// socket proxy (tecnativa/docker-socket-proxy with POST=0).
package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultSocket is the local daemon socket.
const DefaultSocket = "/var/run/docker.sock"

// MinAPIVersion is the oldest Engine API the agent accepts (one-shot stats
// and cgroup v2 daemons). Docker 20.10 and newer satisfy it.
const MinAPIVersion = "1.41"

// Endpoint is a parsed Docker API address.
type Endpoint struct {
	Network string // unix | tcp
	Address string
}

func (e Endpoint) String() string {
	if e.Network == "unix" {
		return e.Address
	}
	return e.Network + "://" + e.Address
}

// ParseEndpoint accepts "unix:///path", "/path", "tcp://host:port" and "host:port".
func ParseEndpoint(s string) (Endpoint, error) {
	s = strings.TrimSpace(s)
	switch {
	case s == "":
		return Endpoint{}, errors.New("docker: empty endpoint")
	case strings.HasPrefix(s, "/"):
		return Endpoint{Network: "unix", Address: s}, nil
	case strings.HasPrefix(s, "unix://"):
		return Endpoint{Network: "unix", Address: strings.TrimPrefix(s, "unix://")}, nil
	case strings.HasPrefix(s, "tcp://"), strings.HasPrefix(s, "http://"):
		u, err := url.Parse(s)
		if err != nil {
			return Endpoint{}, fmt.Errorf("docker: %w", err)
		}
		if u.Host == "" {
			return Endpoint{}, fmt.Errorf("docker: no host in %q", s)
		}
		return Endpoint{Network: "tcp", Address: u.Host}, nil
	}
	if !strings.Contains(s, "://") {
		if _, port, err := net.SplitHostPort(s); err == nil {
			if _, err := strconv.Atoi(port); err == nil {
				return Endpoint{Network: "tcp", Address: s}, nil
			}
		}
	}
	return Endpoint{}, fmt.Errorf("docker: unsupported endpoint %q", s)
}

// Client is a minimal HTTP client bound to one endpoint. Short requests use
// a per-request timeout; streaming requests (events, logs) only time out on
// dial and response headers and otherwise run until their context ends.
type Client struct {
	http   *http.Client
	stream *http.Client
	ep     Endpoint

	mu      sync.Mutex
	version string // negotiated API version, "" until Negotiate succeeds
}

// NewClient builds a client for ep with the given timeout per request.
func NewClient(ep Endpoint, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	newTransport := func() *http.Transport {
		return &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				d := net.Dialer{Timeout: timeout}
				return d.DialContext(ctx, ep.Network, ep.Address)
			},
			ResponseHeaderTimeout: timeout,
			DisableKeepAlives:     true,
		}
	}
	return &Client{
		http:   &http.Client{Transport: newTransport(), Timeout: timeout},
		stream: &http.Client{Transport: newTransport()},
		ep:     ep,
	}
}

// Endpoint returns the address the client is bound to.
func (c *Client) Endpoint() Endpoint { return c.ep }

// Ping calls GET /_ping and returns the API version the daemon reports.
func (c *Client) Ping(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/_ping", nil)
	if err != nil {
		return "", err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("docker: /_ping returned %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	return resp.Header.Get("Api-Version"), nil
}

// VersionInfo is the part of GET /version the agent uses.
type VersionInfo struct {
	Version       string `json:"Version"`
	APIVersion    string `json:"ApiVersion"`
	MinAPIVersion string `json:"MinAPIVersion"`
}

// Negotiate reads GET /version and pins all later requests to the daemon's
// API version. It fails when the daemon is older than MinAPIVersion.
func (c *Client) Negotiate(ctx context.Context) (VersionInfo, error) {
	var v VersionInfo
	if err := c.getJSON(ctx, "/version", nil, &v); err != nil {
		return v, err
	}
	if v.APIVersion == "" {
		return v, errors.New("docker: /version has no ApiVersion")
	}
	if CompareVersion(v.APIVersion, MinAPIVersion) < 0 {
		return v, fmt.Errorf("docker: API version %s is older than the required %s", v.APIVersion, MinAPIVersion)
	}
	c.mu.Lock()
	c.version = v.APIVersion
	c.mu.Unlock()
	return v, nil
}

// Version returns the negotiated API version, or "" before Negotiate.
func (c *Client) Version() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.version
}

// CompareVersion orders "1.41"-style API versions: -1, 0 or 1.
func CompareVersion(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

// APIError is a non-2xx answer from the daemon.
type APIError struct {
	Status  int
	Path    string
	Message string
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("docker: %s returned %d: %s", e.Path, e.Status, e.Message)
	}
	return fmt.Sprintf("docker: %s returned %d", e.Path, e.Status)
}

// ErrNotFound is wrapped by APIError for 404 answers (no such container or image).
var ErrNotFound = errors.New("docker: not found")

// Unwrap lets errors.Is(err, ErrNotFound) work on 404s.
func (e *APIError) Unwrap() error {
	if e.Status == http.StatusNotFound {
		return ErrNotFound
	}
	return nil
}

func (c *Client) url(path string, query url.Values) string {
	u := "http://docker"
	if v := c.Version(); v != "" {
		u += "/v" + v
	}
	u += path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	return u
}

// do issues a GET. stream selects the client without an overall timeout.
// The caller closes the body. Non-2xx answers become *APIError.
func (c *Client) do(ctx context.Context, path string, query url.Values, stream bool) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url(path, query), nil)
	if err != nil {
		return nil, err
	}
	hc := c.http
	if stream {
		hc = c.stream
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		msg := strings.TrimSpace(string(body))
		var m struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(body, &m) == nil && m.Message != "" {
			msg = m.Message
		}
		return nil, &APIError{Status: resp.StatusCode, Path: path, Message: msg}
	}
	return resp, nil
}

func (c *Client) getJSON(ctx context.Context, path string, query url.Values, v any) error {
	resp, err := c.do(ctx, path, query, false)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(v); err != nil {
		return fmt.Errorf("docker: %s: %w", path, err)
	}
	return nil
}
