package journal

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

func TestArgs(t *testing.T) {
	cases := []struct {
		name string
		req  StreamRequest
		want [][]string
		err  bool
	}{
		{"journal", StreamRequest{Source: "journal", Tail: 200},
			[][]string{{"-o", "json", "--no-pager", "-n", "200", "-f"}}, false},
		{"auth with priority and since", StreamRequest{Source: "auth", Tail: 50, Priority: "err", SinceMs: 1_700_000_000_500},
			[][]string{{"-o", "json", "--no-pager", "-p", "0..3", "--since=@1700000000", "-n", "50", "-f",
				"_COMM=sshd", "_COMM=sudo", "_COMM=su", "+", "SYSLOG_IDENTIFIER=systemd-logind", "+", "SYSLOG_IDENTIFIER=sshd"}}, false},
		{"kernel warn", StreamRequest{Source: "kernel", Tail: 10, Priority: "warn"},
			[][]string{{"-o", "json", "--no-pager", "-p", "4..4", "-n", "10", "-f", "-k"}}, false},
		{"packages info with unit", StreamRequest{Source: "packages", Tail: 5, Priority: "info", Unit: "apt-daily.service"},
			[][]string{{"-o", "json", "--no-pager", "-p", "5..7", "-u", "apt-daily.service", "-n", "5", "-f",
				"_COMM=apt", "_COMM=apt-get", "_COMM=dpkg", "_COMM=unattended-upgrade", "+", "SYSLOG_IDENTIFIER=unattended-upgrades"}}, false},
		{"firewall is two processes with half the tail each", StreamRequest{Source: "firewall", Tail: 201},
			[][]string{{"-o", "json", "--no-pager", "-n", "101", "-f", "-k", "-g", "UFW"},
				{"-o", "json", "--no-pager", "-n", "101", "-f", "_COMM=fail2ban-server"}}, false},
		{"negative tail clamps", StreamRequest{Source: "journal", Tail: -3},
			[][]string{{"-o", "json", "--no-pager", "-n", "0", "-f"}}, false},
		{"bad priority", StreamRequest{Source: "journal", Priority: "loud"}, nil, true},
		{"unit injection", StreamRequest{Source: "journal", Unit: "-k"}, nil, true},
		{"web is not a journal source", StreamRequest{Source: "web"}, nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Args(tc.req)
			if tc.err {
				if err == nil {
					t.Fatalf("expected error, got %v", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if fmt.Sprint(got) != fmt.Sprint(tc.want) {
				t.Errorf("\n got %q\nwant %q", got, tc.want)
			}
		})
	}
}

func TestParseLine(t *testing.T) {
	cases := []struct {
		in   string
		want protocol.LogLine
		ok   bool
	}{
		{`{"__REALTIME_TIMESTAMP":"1700000000123456","PRIORITY":"3","_SYSTEMD_UNIT":"nginx.service","MESSAGE":"boom"}`,
			protocol.LogLine{TS: 1700000000123, Unit: "nginx", Priority: "err", Message: "boom"}, true},
		{`{"__REALTIME_TIMESTAMP":"1700000000123456","PRIORITY":"4","SYSLOG_IDENTIFIER":"noise","_COMM":"logger","MESSAGE":"warned"}`,
			protocol.LogLine{TS: 1700000000123, Unit: "noise", Priority: "warn", Message: "warned"}, true},
		{`{"__REALTIME_TIMESTAMP":"1700000000123456","PRIORITY":"6","_COMM":"kworker","MESSAGE":"info"}`,
			protocol.LogLine{TS: 1700000000123, Unit: "kworker", Priority: "info", Message: "info"}, true},
		{`{"__REALTIME_TIMESTAMP":"1700000000123456","_TRANSPORT":"kernel","MESSAGE":[104,101,105,32,255]}`,
			protocol.LogLine{TS: 1700000000123, Priority: "info", Message: "hei �"}, true},
		{`{"__REALTIME_TIMESTAMP":"1700000000123456","PRIORITY":"0","_SYSTEMD_UNIT":[115,115,104,46,115,101,114,118,105,99,101],"MESSAGE":null}`,
			protocol.LogLine{TS: 1700000000123, Unit: "ssh", Priority: "err", Message: ""}, true},
		{`{"PRIORITY":"6","MESSAGE":"no timestamp"}`, protocol.LogLine{}, false},
		{`not json`, protocol.LogLine{}, false},
		{`-- No entries --`, protocol.LogLine{}, false},
	}
	for _, tc := range cases {
		got, ok := ParseLine([]byte(tc.in))
		if ok != tc.ok || got != tc.want {
			t.Errorf("ParseLine(%s) = %+v, %v; want %+v, %v", tc.in, got, ok, tc.want, tc.ok)
		}
	}
	if MapPriority("x") != "info" || MapPriority("7") != "info" || MapPriority("3") != "err" || MapPriority("4") != "warn" {
		t.Error("MapPriority")
	}
}

// fakeRunner returns canned output per argument list and records calls.
type fakeRunner struct {
	mu     sync.Mutex
	calls  [][]string
	output func(args []string) (string, error)
}

func (f *fakeRunner) run(ctx context.Context, args []string) (io.ReadCloser, error) {
	f.mu.Lock()
	f.calls = append(f.calls, args)
	f.mu.Unlock()
	out, err := f.output(args)
	if err != nil {
		return nil, err
	}
	return io.NopCloser(strings.NewReader(out)), nil
}

func jsonEntry(ts int64, prio, unit, msg string) string {
	return fmt.Sprintf(`{"__REALTIME_TIMESTAMP":"%d","PRIORITY":%q,"_SYSTEMD_UNIT":%q,"MESSAGE":%q}`, ts*1000, prio, unit, msg)
}

func TestStreamParsesAndMerges(t *testing.T) {
	fr := &fakeRunner{output: func(args []string) (string, error) {
		if args[len(args)-1] == "UFW" {
			return jsonEntry(1_700_000_000_000, "4", "", "[UFW BLOCK] IN=eth0") + "\n", nil
		}
		return jsonEntry(1_700_000_001_000, "6", "fail2ban.service", "Ban 1.2.3.4") + "\ngarbage\n", nil
	}}
	j := New(nil, fr.run)
	out := make(chan protocol.LogLine, 8)
	if err := j.Stream(context.Background(), StreamRequest{Source: "firewall", Tail: 10}, out); err != nil {
		t.Fatal(err)
	}
	close(out)
	var msgs []string
	for l := range out {
		msgs = append(msgs, l.Message)
	}
	if len(msgs) != 2 {
		t.Errorf("got %q", msgs)
	}
	if len(fr.calls) != 2 {
		t.Errorf("firewall should start two processes, got %d", len(fr.calls))
	}
}

func TestStreamReportsUnavailable(t *testing.T) {
	fr := &fakeRunner{output: func([]string) (string, error) { return "", ErrUnavailable }}
	j := New(nil, fr.run)
	err := j.Stream(context.Background(), StreamRequest{Source: "journal"}, make(chan protocol.LogLine, 1))
	if !errors.Is(err, ErrUnavailable) {
		t.Errorf("got %v", err)
	}
	if _, err := New(nil, nil).run(context.Background(), []string{"--version"}); err != nil && !errors.Is(err, ErrUnavailable) {
		t.Errorf("real runner without journalctl should give ErrUnavailable, got %v", err)
	}
}

// A fake journalctl script proves the process is killed and reaped on cancel.
func TestStreamKillsProcessOnCancel(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "journalctl")
	marker := filepath.Join(dir, "started")
	body := "#!/bin/sh\necho '" + jsonEntry(1_700_000_000_000, "6", "x.service", "first") + "'\ntouch " + marker + "\nwhile :; do sleep 1; done\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	run := func(ctx context.Context, args []string) (io.ReadCloser, error) {
		return startProcess(ctx, script, args)
	}
	j := New(nil, run)
	out := make(chan protocol.LogLine, 8)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- j.Stream(ctx, StreamRequest{Source: "journal", Tail: 1}, out) }()
	select {
	case l := <-out:
		if l.Message != "first" {
			t.Errorf("line %+v", l)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no line from the fake journalctl")
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	start := time.Now()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("want context.Canceled, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Stream did not return after cancel")
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("cancel took %v", d)
	}
	// No process from the script is left: pgrep by the marker path in the command line.
	out2, _ := runCmd("pgrep", "-f", marker)
	if strings.TrimSpace(out2) != "" {
		t.Errorf("fake journalctl still running: %q", out2)
	}
}

func TestTailPreludeFollowRotateTruncate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "access.log")
	if err := os.WriteFile(path, []byte("l1\nl2\nl3\nl4\npartial"), 0o644); err != nil {
		t.Fatal(err)
	}
	out := make(chan protocol.LogLine, 64)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- Tail(ctx, []string{path, filepath.Join(dir, "missing.log")}, 2, true, out, TailOptions{Poll: 5 * time.Millisecond})
	}()
	next := func(want string) {
		t.Helper()
		select {
		case l := <-out:
			if l.Message != want || l.Unit != filepath.Base(dir)+"/access" {
				t.Errorf("got %+v want message %q", l, want)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("timeout waiting for %q", want)
		}
	}
	next("l3")
	next("l4")
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString(" line\nl6\n")
	f.Close()
	next("partial line")
	next("l6")
	// Rotation: move the file away and create a new one at the path.
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("fresh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	next("fresh")
	// Truncation in place.
	if err := os.WriteFile(path, []byte("t\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	next("t")
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Errorf("want Canceled, got %v", err)
	}
	// No readable files: unavailable. No follow: returns nil after the prelude.
	if err := Tail(context.Background(), []string{filepath.Join(dir, "nope")}, 5, true, out, TailOptions{}); !errors.Is(err, ErrUnavailable) {
		t.Errorf("want ErrUnavailable, got %v", err)
	}
	if err := Tail(context.Background(), []string{path}, 5, false, out, TailOptions{}); err != nil {
		t.Errorf("no-follow: %v", err)
	}
	if paths := ReadablePaths([]string{path, filepath.Join(dir, "nope")}); len(paths) != 1 {
		t.Errorf("ReadablePaths = %v", paths)
	}
}

func TestLastLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f")
	write := func(s string) *os.File {
		if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
		f, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		return f
	}
	f := write("a\nb\nc\n")
	lines, end, err := lastLines(f, 2, 1<<10)
	f.Close()
	if err != nil || strings.Join(lines, ",") != "b,c" || end != 6 {
		t.Errorf("lastLines = %q %d %v", lines, end, err)
	}
	f = write("only\n")
	lines, end, _ = lastLines(f, 5, 1<<10)
	f.Close()
	if strings.Join(lines, ",") != "only" || end != 5 {
		t.Errorf("single line = %q %d", lines, end)
	}
	f = write("")
	lines, end, _ = lastLines(f, 5, 1<<10)
	f.Close()
	if len(lines) != 0 || end != 0 {
		t.Errorf("empty = %q %d", lines, end)
	}
	f = write("x\r\ny\r\n")
	lines, _, _ = lastLines(f, 5, 1<<10)
	f.Close()
	if strings.Join(lines, ",") != "x,y" {
		t.Errorf("crlf = %q", lines)
	}
}

func TestCounterRefresh(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	ssh := strings.Join([]string{
		jsonEntry(now.Add(-20*time.Hour).UnixMilli(), "6", "ssh.service", "Failed password for root from 45.33.12.9 port 1 ssh2"),
		jsonEntry(now.Add(-30*time.Minute).UnixMilli(), "6", "ssh.service", "Invalid user admin from 185.220.101.4 port 40122"),
		jsonEntry(now.Add(-10*time.Minute).UnixMilli(), "6", "ssh.service", "Accepted publickey for ole from 10.0.0.2 port 2 ssh2"),
		jsonEntry(now.Add(-5*time.Minute).UnixMilli(), "6", "ssh.service", "Failed password for invalid user test from 1.2.3.4 port 5 ssh2"),
		jsonEntry(now.Add(-1*time.Minute).UnixMilli(), "6", "ssh.service", "pam_unix(sshd:auth): authentication failure; rhost=9.9.9.9"),
	}, "\n") + "\n"
	fr := &fakeRunner{output: func(args []string) (string, error) {
		switch args[len(args)-1] {
		case "SYSLOG_IDENTIFIER=sshd":
			return ssh, nil
		case "UFW BLOCK":
			return "[UFW BLOCK] a\n[UFW BLOCK] b\n", nil
		case " Ban ":
			return "NOTICE [sshd] Ban 1.1.1.1\n", nil
		}
		return "", fmt.Errorf("unexpected args %q", args)
	}}
	c := NewCounter(nil, fr.run, func() time.Time { return now })
	if got := c.SecurityCounts(context.Background()); got.SSHFailedDay != 0 {
		t.Errorf("before refresh: %+v", got)
	}
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := c.SecurityCounts(context.Background())
	if got.SSHFailedDay != 4 || got.SSHFailedHour != 3 || got.UFWBlocked != 2 || got.Fail2banBanned != 1 {
		t.Errorf("counts %+v", got)
	}
	if len(got.SSHLast) != 3 || got.SSHLast[0].User != "admin" || got.SSHLast[0].From != "185.220.101.4" ||
		got.SSHLast[1].User != "test" || got.SSHLast[1].From != "1.2.3.4" || got.SSHLast[2].User != "" || got.SSHLast[2].At != now.Add(-time.Minute).UnixMilli() {
		t.Errorf("last %+v", got.SSHLast)
	}
	if len(fr.calls) != 3 {
		t.Errorf("%d journalctl runs", len(fr.calls))
	}
	// A failing query zeroes its number and reports the error; the others still count.
	fr.output = func(args []string) (string, error) {
		if args[len(args)-1] == "UFW BLOCK" {
			return "", errors.New("grep unsupported")
		}
		return "", nil
	}
	if err := c.Refresh(context.Background()); err == nil {
		t.Error("expected error")
	}
	got = c.SecurityCounts(context.Background())
	if got.UFWBlocked != 0 || got.SSHFailedDay != 0 {
		t.Errorf("after failure %+v", got)
	}
	if err, at := c.Err(); err == nil || !at.Equal(now) {
		t.Errorf("Err() = %v %v", err, at)
	}
}

func TestRawStringShapes(t *testing.T) {
	if rawString(nil) != "" || rawString([]byte("null")) != "" || rawString([]byte(`"x"`)) != "x" || rawString([]byte(`[104,105]`)) != "hi" || rawString([]byte(`12`)) != "12" {
		t.Error("rawString")
	}
	var buf bytes.Buffer
	buf.WriteString(`{"__REALTIME_TIMESTAMP":"1","MESSAGE":"` + strings.Repeat("m", 100) + `"}` + "\n")
	j := New(nil, nil)
	j.MaxLine = 10
	out := make(chan protocol.LogLine, 1)
	if err := j.pump(context.Background(), &buf, out); err != nil {
		t.Fatal(err)
	}
	if l := <-out; len(l.Message) != 10 {
		t.Errorf("MaxLine not applied: %d", len(l.Message))
	}
}
