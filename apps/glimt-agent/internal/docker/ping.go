// Package docker talks to the Docker Engine API read-only. For now it only
// knows how to ping an endpoint; listing containers comes in step 1.6.
package docker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultSocket is the local daemon socket.
const DefaultSocket = "/var/run/docker.sock"

// DefaultProxyURL is where docker-socket-proxy is expected.
const DefaultProxyURL = "tcp://127.0.0.1:2375"

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

// Client is a minimal HTTP client bound to one endpoint.
type Client struct {
	http *http.Client
	ep   Endpoint
}

// NewClient builds a client for ep with the given timeout per request.
func NewClient(ep Endpoint, timeout time.Duration) *Client {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, ep.Network, ep.Address)
		},
		DisableKeepAlives: true,
	}
	return &Client{http: &http.Client{Transport: tr, Timeout: timeout}, ep: ep}
}

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
