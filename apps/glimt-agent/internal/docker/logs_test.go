package docker

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func collect(t *testing.T, input []byte, tty bool) []string {
	t.Helper()
	var lines []string
	if err := Demux(bytes.NewReader(input), tty, func(l []byte) bool { lines = append(lines, string(l)); return true }); err != nil {
		t.Fatal(err)
	}
	return lines
}

func TestDemuxFrames(t *testing.T) {
	// Frames split lines, join lines and interleave streams.
	in := frame(1, "a\nb")
	in = append(in, frame(2, "err1\n")...)
	in = append(in, frame(1, "c\nd\n")...)
	in = append(in, frame(2, "partial")...)
	got := collect(t, in, false)
	want := []string{"a", "err1", "bc", "d", "partial"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("got %q want %q", got, want)
	}
	if got := collect(t, nil, false); len(got) != 0 {
		t.Errorf("empty input gave %q", got)
	}
	// A truncated header is treated as EOF, not an error.
	if got := collect(t, append(frame(1, "x\n"), 1, 0, 0), false); len(got) != 1 || got[0] != "x" {
		t.Errorf("truncated header: %q", got)
	}
	// CRLF is trimmed.
	if got := collect(t, frame(1, "win\r\n"), false); got[0] != "win" {
		t.Errorf("crlf: %q", got)
	}
}

func TestDemuxTTY(t *testing.T) {
	got := collect(t, []byte("one\ntwo\r\nthree"), true)
	if strings.Join(got, "|") != "one|two|three" {
		t.Errorf("tty lines %q", got)
	}
	long := strings.Repeat("x", 100<<10) + "\nafter\n"
	got = collect(t, []byte(long), true)
	if len(got) != 2 || len(got[0]) != maxLogLine || got[1] != "after" {
		t.Errorf("long line: %d lines, first %d bytes", len(got), len(got[0]))
	}
}

func TestDemuxStopsWhenEmitReturnsFalse(t *testing.T) {
	in := append(frame(1, "a\nb\nc\n"), frame(1, "d\n")...)
	n := 0
	err := Demux(bytes.NewReader(in), false, func([]byte) bool { n++; return n < 2 })
	if err != nil || n != 2 {
		t.Errorf("n=%d err=%v", n, err)
	}
}

func TestSplitTimestamp(t *testing.T) {
	now := func() time.Time { return time.UnixMilli(42) }
	ts, msg := splitTimestamp([]byte("2025-09-01T10:00:00.250Z hello world"), now)
	if ts != time.Date(2025, 9, 1, 10, 0, 0, 250_000_000, time.UTC).UnixMilli() || msg != "hello world" {
		t.Errorf("ts=%d msg=%q", ts, msg)
	}
	ts, msg = splitTimestamp([]byte("no timestamp here"), now)
	if ts != 42 || msg != "no timestamp here" {
		t.Errorf("fallback ts=%d msg=%q", ts, msg)
	}
	ts, msg = splitTimestamp([]byte("2025-09-01T10:00:00Z"), now)
	if ts != 42 || msg != "2025-09-01T10:00:00Z" {
		t.Errorf("timestamp without message ts=%d msg=%q", ts, msg)
	}
}

func TestFormatHelpers(t *testing.T) {
	if got := mapState("exited"); got != "stopped" {
		t.Errorf("exited → %q", got)
	}
	if got := mapState("weird"); got != "stopped" {
		t.Errorf("unknown → %q", got)
	}
	if got := parseTimeMs("0001-01-01T00:00:00Z"); got != 0 {
		t.Errorf("zero time → %d", got)
	}
	if got := shortID("abc"); got != "abc" {
		t.Errorf("short id %q", got)
	}
	if got := containerName(nil); got != "" {
		t.Errorf("no names → %q", got)
	}
	if rx, tx := rate(100, 200, 5, 1, 2*time.Second); rx != 0 || tx != 2 {
		t.Errorf("rate wrap: %v %v", rx, tx)
	}
}
