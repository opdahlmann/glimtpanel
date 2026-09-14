package health

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestParseChecks(t *testing.T) {
	got, err := ParseChecks(" db=postgres:5432, cache=redis:6379 ,, mail:25 ")
	if err != nil {
		t.Fatal(err)
	}
	want := []Target{{"db", "postgres:5432"}, {"cache", "redis:6379"}, {"mail", "mail:25"}}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("%d: got %+v want %+v", i, got[i], want[i])
		}
	}
	if got, err := ParseChecks(""); err != nil || got != nil {
		t.Errorf("empty: %+v %v", got, err)
	}
	for _, bad := range []string{"db=postgres", "=x:1", "db=:5432:x"} {
		if _, err := ParseChecks(bad); err == nil {
			t.Errorf("%q should fail", bad)
		}
	}
}

func TestHealthURL(t *testing.T) {
	status := 200
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "/healthz", http.StatusFound)
			return
		}
		w.WriteHeader(status)
	}))
	defer srv.Close()

	c := &Checker{URL: srv.URL + "/healthz"}
	h, checks := c.Run(context.Background())
	if h == nil || !h.OK || h.Status != 200 || h.CheckedAt == 0 || h.URL != srv.URL+"/healthz" || checks != nil {
		t.Errorf("ok: %+v %+v", h, checks)
	}
	status = 503
	h, _ = c.Run(context.Background())
	if h.OK || h.Status != 503 || h.Error == "" {
		t.Errorf("503: %+v", h)
	}
	// Redirects are not followed: the 302 is the answer.
	c = &Checker{URL: srv.URL + "/redirect"}
	h, _ = c.Run(context.Background())
	if h.OK || h.Status != 302 {
		t.Errorf("redirect: %+v", h)
	}
	// Nothing listening.
	c = &Checker{URL: "http://127.0.0.1:1/healthz", HTTPTimeout: 500 * time.Millisecond}
	h, _ = c.Run(context.Background())
	if h.OK || h.Error == "" {
		t.Errorf("refused: %+v", h)
	}
}

func TestTCPChecks(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	c := &Checker{Targets: []Target{{"db", ln.Addr().String()}, {"cache", "127.0.0.1:1"}}, TCPTimeout: 500 * time.Millisecond}
	h, checks := c.Run(context.Background())
	if h != nil || len(checks) != 2 {
		t.Fatalf("%+v %+v", h, checks)
	}
	if !checks[0].OK || checks[0].Name != "db" || checks[0].Target != ln.Addr().String() {
		t.Errorf("db: %+v", checks[0])
	}
	if checks[1].OK || checks[1].Error == "" {
		t.Errorf("cache: %+v", checks[1])
	}
	if (&Checker{}).Enabled() {
		t.Error("empty checker should be disabled")
	}
}
