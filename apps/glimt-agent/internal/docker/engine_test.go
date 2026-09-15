package docker

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

const (
	webID = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	dbID  = "0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff"
	imgID = "sha256:9999888877776666555544443333222211110000ffffeeeeddddccccbbbbaaaa"
)

var listFixture = fmt.Sprintf(`[
 {"Id":%q,"Names":["/web-web-1"],"Image":"nginx:1.27","ImageID":%q,"State":"running","Status":"Up 2 hours (healthy)",
  "Labels":{"com.docker.compose.project":"web"},
  "Ports":[{"IP":"0.0.0.0","PrivatePort":8080,"PublicPort":80,"Type":"tcp"},{"IP":"::","PrivatePort":8080,"PublicPort":80,"Type":"tcp"},
           {"IP":"0.0.0.0","PrivatePort":5353,"PublicPort":5353,"Type":"udp"},{"PrivatePort":9000,"Type":"tcp"}],
  "Mounts":[{"Type":"bind","Source":"/srv/nginx","Destination":"/etc/nginx/conf.d"},{"Type":"volume","Name":"data","Source":"/var/lib/docker/volumes/data/_data","Destination":"/data"}]},
 {"Id":%q,"Names":["/db"],"Image":"postgres:16","ImageID":%q,"State":"exited","Status":"Exited (0) 3 days ago","Labels":{},"Ports":[],"Mounts":[]}
]`, webID, imgID, dbID, imgID)

func inspectFixture(id string, running bool, pid int, tty bool) string {
	state := `"Status":"exited","Running":false,"Pid":0,"StartedAt":"0001-01-01T00:00:00Z"`
	if running {
		state = fmt.Sprintf(`"Status":"running","Running":true,"Pid":%d,"StartedAt":"2025-09-01T10:00:00.5Z","Health":{"Status":"healthy"}`, pid)
	}
	return fmt.Sprintf(`{"Id":%q,"Name":"/name-%s","RestartCount":3,"State":{%s},"Config":{"Tty":%v,"Labels":{}},"HostConfig":{"CgroupParent":"","Memory":0}}`, id, id[:4], state, tty)
}

// fakeDaemon serves the fixtures and counts calls per path.
type fakeDaemon struct {
	srv      *httptest.Server
	mu       sync.Mutex
	calls    map[string]int
	stats    string
	events   chan string
	logBody  []byte
	apiVer   string
	tty      bool
	closeLog chan struct{}
}

func newFakeDaemon(t *testing.T) *fakeDaemon {
	t.Helper()
	d := &fakeDaemon{calls: map[string]int{}, events: make(chan string, 8), apiVer: "1.47", closeLog: make(chan struct{})}
	d.stats = `{"read":"2025-09-01T10:00:01Z","cpu_stats":{"cpu_usage":{"total_usage":2000000000}},"memory_stats":{"usage":300000000,"limit":1073741824,"stats":{"inactive_file":100000000}},"networks":{"eth0":{"rx_bytes":5000,"tx_bytes":1000},"eth1":{"rx_bytes":5000,"tx_bytes":1000}}}`
	d.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		d.mu.Lock()
		d.calls[r.URL.Path]++
		d.mu.Unlock()
		path := strings.TrimPrefix(r.URL.Path, "/v"+d.apiVer)
		switch {
		case path == "/version":
			fmt.Fprintf(w, `{"Version":"27.0.0","ApiVersion":%q,"MinAPIVersion":"1.24"}`, d.apiVer)
		case path == "/containers/json":
			if r.URL.Query().Get("all") != "1" {
				http.Error(w, "all=1 expected", 400)
				return
			}
			io.WriteString(w, listFixture)
		case path == "/containers/"+webID+"/json", path == "/containers/web-web-1/json", path == "/containers/"+webID[:12]+"/json":
			io.WriteString(w, inspectFixture(webID, true, 4242, d.tty))
		case path == "/containers/"+dbID+"/json":
			io.WriteString(w, inspectFixture(dbID, false, 0, false))
		case path == "/images/"+imgID+"/json":
			io.WriteString(w, `{"Id":"x","Created":"2025-08-01T00:00:00Z"}`)
		case path == "/containers/"+webID+"/stats":
			if r.URL.Query().Get("one-shot") != "true" || r.URL.Query().Get("stream") != "false" {
				http.Error(w, "one-shot expected", 400)
				return
			}
			d.mu.Lock()
			io.WriteString(w, d.stats)
			d.mu.Unlock()
		case path == "/events":
			fl, _ := w.(http.Flusher)
			w.WriteHeader(200)
			fl.Flush()
			for {
				select {
				case ev, ok := <-d.events:
					if !ok {
						return
					}
					io.WriteString(w, ev+"\n")
					fl.Flush()
				case <-r.Context().Done():
					return
				}
			}
		case strings.HasSuffix(path, "/logs"):
			if r.URL.Query().Get("tail") != "5" || r.URL.Query().Get("timestamps") != "1" {
				http.Error(w, "bad query "+r.URL.RawQuery, 400)
				return
			}
			w.Header().Set("Content-Type", "application/vnd.docker.raw-stream")
			w.Write(d.logBody)
			if fl, ok := w.(http.Flusher); ok {
				fl.Flush()
			}
			select {
			case <-d.closeLog:
			case <-r.Context().Done():
			}
		default:
			w.WriteHeader(404)
			io.WriteString(w, `{"message":"No such container: `+path+`"}`)
		}
	}))
	t.Cleanup(d.srv.Close)
	return d
}

func (d *fakeDaemon) count(path string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.calls[path]
}

func (d *fakeDaemon) engine(t *testing.T, now *fakeClock, procRoot, sysRoot string) *Engine {
	t.Helper()
	ep, _ := ParseEndpoint("tcp://" + d.srv.Listener.Addr().String())
	return NewEngine(Options{Client: NewClient(ep, 2*time.Second), ProcRoot: procRoot, SysRoot: sysRoot, Now: now.Now, StatsAPIInterval: 5 * time.Second})
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock() *fakeClock { return &fakeClock{t: time.Date(2025, 9, 1, 12, 0, 0, 0, time.UTC)} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func frame(stream byte, s string) []byte {
	hdr := make([]byte, 8)
	hdr[0] = stream
	binary.BigEndian.PutUint32(hdr[4:], uint32(len(s)))
	return append(hdr, s...)
}

func TestNegotiateRejectsOldDaemon(t *testing.T) {
	d := newFakeDaemon(t)
	d.apiVer = "1.40"
	e := d.engine(t, newFakeClock(), t.TempDir(), t.TempDir())
	if _, err := e.List(context.Background()); err == nil || !strings.Contains(err.Error(), "older") {
		t.Fatalf("expected version error, got %v", err)
	}
	if e.Reachable() {
		t.Error("should not be reachable after a failed negotiation")
	}
	if CompareVersion("1.41", "1.9") <= 0 || CompareVersion("1.41", "1.41") != 0 || CompareVersion("1.24", "1.41") >= 0 {
		t.Error("CompareVersion")
	}
}

func TestListMapsContainers(t *testing.T) {
	d := newFakeDaemon(t)
	e := d.engine(t, newFakeClock(), t.TempDir(), t.TempDir())
	cs, err := e.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !e.Reachable() || e.Client().Version() != "1.47" {
		t.Errorf("reachable=%v version=%q", e.Reachable(), e.Client().Version())
	}
	if len(cs) != 2 {
		t.Fatalf("got %d containers", len(cs))
	}
	web := cs[0]
	want := protocol.Container{
		ID: webID[:12], Name: "name-a1b2", Image: "nginx:1.27", ImageCreated: time.Date(2025, 8, 1, 0, 0, 0, 0, time.UTC).UnixMilli(),
		State: "running", Health: "healthy", RestartCount: 3, StartedAt: time.Date(2025, 9, 1, 10, 0, 0, 500_000_000, time.UTC).UnixMilli(),
		Ports: []string{"5353→5353/udp", "80→8080"}, Mounts: []string{"/srv/nginx → /etc/nginx/conf.d", "data → /data"}, Compose: "web",
	}
	if fmt.Sprint(web) != fmt.Sprint(want) {
		t.Errorf("web container\n got %+v\nwant %+v", web, want)
	}
	db := cs[1]
	if db.State != "stopped" || db.Health != "none" || db.StartedAt != 0 || db.Name != "name-0000" || len(db.Ports) != 0 {
		t.Errorf("db container %+v", db)
	}
	// Second list reuses inspect and image caches.
	if _, err := e.List(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := d.count("/v1.47/containers/" + webID + "/json"); n != 1 {
		t.Errorf("inspect called %d times, want 1 (cached)", n)
	}
	if n := d.count("/v1.47/images/" + imgID + "/json"); n != 1 {
		t.Errorf("image inspect called %d times, want 1 (cached)", n)
	}
	if n := d.count("/version"); n != 1 {
		t.Errorf("version negotiated %d times", n)
	}
}

func writeCgroup(t *testing.T, dir string, usec, current, inactive uint64, max string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"cpu.stat":       fmt.Sprintf("usage_usec %d\nuser_usec 1\nsystem_usec 1\n", usec),
		"memory.current": fmt.Sprintf("%d\n", current),
		"memory.stat":    fmt.Sprintf("anon 1\nfile 2\ninactive_file %d\nactive_file 3\n", inactive),
		"memory.max":     max + "\n",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func writeNetDev(t *testing.T, procRoot string, pid int, rx, tx uint64) {
	t.Helper()
	dir := filepath.Join(procRoot, fmt.Sprint(pid), "net")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := fmt.Sprintf(`Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 999999 10 0 0 0 0 0 0 999999 10 0 0 0 0 0 0
  eth0: %d 100 0 0 0 0 0 0 %d 50 0 0 0 0 0 0
`, rx, tx)
	if err := os.WriteFile(filepath.Join(dir, "dev"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestStatsFromCgroupAndProc(t *testing.T) {
	d := newFakeDaemon(t)
	clock := newFakeClock()
	proc, sys := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(proc, "meminfo"), []byte("MemTotal:        8000000 kB\nMemFree: 1 kB\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cg := filepath.Join(sys, "fs", "cgroup", "system.slice", "docker-"+webID+".scope")
	writeCgroup(t, cg, 1_000_000, 500_000_000, 100_000_000, "max")
	writeNetDev(t, proc, 4242, 10_000, 2_000)
	e := d.engine(t, clock, proc, sys)
	cs, err := e.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	first, err := e.Stats(context.Background(), cs)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 2 || first[0].CPUPct != 0 || first[0].MemBytes != 400_000_000 || first[0].MemLimit != 8000000*1024 || first[1].State != "stopped" {
		t.Errorf("first stats %+v", first)
	}

	clock.Advance(2 * time.Second)
	writeCgroup(t, cg, 1_000_000+500_000, 600_000_000, 100_000_000, "1073741824")
	writeNetDev(t, proc, 4242, 10_000+20_000, 2_000+4_000)
	second, err := e.Stats(context.Background(), cs)
	if err != nil {
		t.Fatal(err)
	}
	w := second[0]
	if w.CPUPct != 25 || w.MemBytes != 500_000_000 || w.MemLimit != 1073741824 || w.RxBps != 10_000 || w.TxBps != 2_000 || w.State != "running" {
		t.Errorf("second stats %+v", w)
	}
	if n := d.count("/v1.47/containers/" + webID + "/stats"); n != 0 {
		t.Errorf("stats API used %d times although cgroup and /proc were readable", n)
	}
}

func TestStatsFallsBackToAPIForNetwork(t *testing.T) {
	d := newFakeDaemon(t)
	clock := newFakeClock()
	proc, sys := t.TempDir(), t.TempDir()
	cg := filepath.Join(sys, "fs", "cgroup", "docker", webID)
	writeCgroup(t, cg, 0, 1, 0, "max")
	e := d.engine(t, clock, proc, sys)
	cs, err := e.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// No /proc/4242: network comes from the API, throttled to every 5 s.
	if _, err := e.Stats(context.Background(), cs); err != nil {
		t.Fatal(err)
	}
	clock.Advance(time.Second)
	if _, err := e.Stats(context.Background(), cs); err != nil {
		t.Fatal(err)
	}
	if n := d.count("/v1.47/containers/" + webID + "/stats"); n != 1 {
		t.Errorf("stats API called %d times within 5 s, want 1", n)
	}
	clock.Advance(5 * time.Second)
	d.mu.Lock()
	d.stats = strings.Replace(d.stats, `"rx_bytes":5000,"tx_bytes":1000},"eth1"`, `"rx_bytes":65000,"tx_bytes":13000},"eth1"`, 1)
	d.mu.Unlock()
	st, err := e.Stats(context.Background(), cs)
	if err != nil {
		t.Fatal(err)
	}
	// 6 s between samples; rx grew by 60000, tx by 12000.
	if st[0].RxBps != 10_000 || st[0].TxBps != 2_000 {
		t.Errorf("api network rates %+v", st[0])
	}
	if st[0].MemBytes != 1 {
		t.Errorf("memory should still come from cgroup files: %+v", st[0])
	}
}

func TestStatsFallsBackToAPIWithoutCgroup(t *testing.T) {
	d := newFakeDaemon(t)
	clock := newFakeClock()
	e := d.engine(t, clock, t.TempDir(), t.TempDir())
	cs, _ := e.List(context.Background())
	if _, err := e.Stats(context.Background(), cs); err != nil {
		t.Fatal(err)
	}
	clock.Advance(10 * time.Second)
	d.mu.Lock()
	d.stats = strings.Replace(d.stats, `"total_usage":2000000000`, `"total_usage":4000000000`, 1)
	d.mu.Unlock()
	st, err := e.Stats(context.Background(), cs)
	if err != nil {
		t.Fatal(err)
	}
	// 2 s of CPU over 10 s = 20 %; memory 300 MB minus 100 MB inactive file.
	if st[0].CPUPct != 20 || st[0].MemBytes != 200_000_000 || st[0].MemLimit != 1073741824 {
		t.Errorf("api stats %+v", st[0])
	}
}

func TestEventsInvalidateAndCallBack(t *testing.T) {
	d := newFakeDaemon(t)
	e := d.engine(t, newFakeClock(), t.TempDir(), t.TempDir())
	if _, err := e.List(context.Background()); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- e.Events(ctx, func() { calls.Add(1) }) }()
	d.events <- fmt.Sprintf(`{"Type":"container","Action":"die","Actor":{"ID":%q,"Attributes":{"name":"web"}},"timeNano":1}`, webID)
	deadline := time.Now().Add(3 * time.Second)
	for calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if calls.Load() != 1 {
		t.Fatalf("callback called %d times", calls.Load())
	}
	e.mu.Lock()
	_, cached := e.inspects[webID]
	e.mu.Unlock()
	if cached {
		t.Error("event should have invalidated the inspect cache")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Error("Events should return the context error")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Events did not stop")
	}
	// The next List re-inspects the invalidated container.
	if _, err := e.List(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := d.count("/v1.47/containers/" + webID + "/json"); n != 2 {
		t.Errorf("inspect after event called %d times, want 2", n)
	}
}

func TestLogsOverHTTP(t *testing.T) {
	d := newFakeDaemon(t)
	d.logBody = append(frame(1, "2025-09-01T10:00:00.123456789Z hello\n2025-09-01T10:00:01Z wor"), frame(2, "2025-09-01T10:00:02Z from stderr\n")...)
	d.logBody = append(d.logBody, frame(1, "ld\n")...)
	e := d.engine(t, newFakeClock(), t.TempDir(), t.TempDir())
	out := make(chan protocol.LogLine, 16)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- e.Logs(ctx, "web-web-1", 5, 0, out) }()
	var got []protocol.LogLine
	timeout := time.After(3 * time.Second)
	for len(got) < 3 {
		select {
		case l := <-out:
			got = append(got, l)
		case <-timeout:
			t.Fatalf("only %d lines: %+v", len(got), got)
		}
	}
	if got[0].Message != "hello" || got[0].TS != time.Date(2025, 9, 1, 10, 0, 0, 123456789, time.UTC).UnixMilli() || got[0].Container != "name-a1b2" {
		t.Errorf("line 0 %+v", got[0])
	}
	if got[1].Message != "from stderr" || got[2].Message != "world" || got[2].TS != time.Date(2025, 9, 1, 10, 0, 1, 0, time.UTC).UnixMilli() {
		t.Errorf("lines %+v", got[1:])
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Error("cancelled Logs should return the context error")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Logs did not stop on cancel")
	}
	// Unknown container: a not-found error.
	if err := e.Logs(context.Background(), "nope", 5, 0, out); err == nil || !strings.Contains(err.Error(), "No such container") {
		t.Errorf("expected not found, got %v", err)
	}
	var apiErr *APIError
	err := e.Logs(context.Background(), "nope", 5, 0, out)
	if !isNotFound(err) || !asAPIError(err, &apiErr) || apiErr.Status != 404 {
		t.Errorf("error should be a 404 APIError: %v", err)
	}
}

func TestLogsEOFIsNil(t *testing.T) {
	d := newFakeDaemon(t)
	d.logBody = frame(1, "2025-09-01T10:00:00Z bye\n")
	close(d.closeLog)
	e := d.engine(t, newFakeClock(), t.TempDir(), t.TempDir())
	out := make(chan protocol.LogLine, 16)
	if err := e.Logs(context.Background(), webID[:12], 5, 1_700_000_000_000, out); err != nil {
		t.Fatalf("EOF should be nil, got %v", err)
	}
	if l := <-out; l.Message != "bye" {
		t.Errorf("line %+v", l)
	}
}

func TestListJSONDecodesFixtures(t *testing.T) {
	var s []containerSummary
	if err := json.Unmarshal([]byte(listFixture), &s); err != nil || len(s) != 2 || s[0].Labels["com.docker.compose.project"] != "web" {
		t.Fatalf("fixture: %v %+v", err, s)
	}
}
