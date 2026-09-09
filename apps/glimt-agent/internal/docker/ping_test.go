package docker

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestParseEndpoint(t *testing.T) {
	cases := map[string]Endpoint{
		"/var/run/docker.sock":        {Network: "unix", Address: "/var/run/docker.sock"},
		"unix:///run/docker.sock":     {Network: "unix", Address: "/run/docker.sock"},
		"tcp://127.0.0.1:2375":        {Network: "tcp", Address: "127.0.0.1:2375"},
		"http://localhost:2375":       {Network: "tcp", Address: "localhost:2375"},
		"127.0.0.1:2375":              {Network: "tcp", Address: "127.0.0.1:2375"},
		"unix:///var/run/docker.sock": {Network: "unix", Address: "/var/run/docker.sock"},
	}
	for in, want := range cases {
		got, err := ParseEndpoint(in)
		if err != nil || got != want {
			t.Errorf("ParseEndpoint(%q) = %+v, %v; want %+v", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "ftp://x", "just-a-host"} {
		if _, err := ParseEndpoint(bad); err == nil {
			t.Errorf("ParseEndpoint(%q) should fail", bad)
		}
	}
}

func pingHandler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/_ping" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Api-Version", "1.47")
	_, _ = w.Write([]byte("OK"))
}

func TestPingTCP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(pingHandler))
	defer srv.Close()
	ep, _ := ParseEndpoint("tcp://" + srv.Listener.Addr().String())
	v, err := NewClient(ep, time.Second).Ping(context.Background())
	if err != nil || v != "1.47" {
		t.Errorf("ping: %q %v", v, err)
	}
}

func TestPingUnix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix sockets")
	}
	path := filepath.Join(t.TempDir(), "d.sock")
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(pingHandler)}
	go func() { _ = srv.Serve(l) }()
	defer srv.Close()
	ep, _ := ParseEndpoint(path)
	v, err := NewClient(ep, time.Second).Ping(context.Background())
	if err != nil || v != "1.47" {
		t.Errorf("ping: %q %v", v, err)
	}
	// A dead endpoint is an error, not a hang.
	dead, _ := ParseEndpoint(filepath.Join(t.TempDir(), "missing.sock"))
	if _, err := NewClient(dead, 200*time.Millisecond).Ping(context.Background()); err == nil {
		t.Error("missing socket should fail")
	}
}
