package logs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

func TestPathAllowed(t *testing.T) {
	allowed := []string{"/var/log/app", "/srv/app.log"}
	for path, want := range map[string]bool{
		"/var/log/app/today.log": true, "/var/log/app": true, "/srv/app.log": true,
		"/var/log/apparmor.log": false, "/srv/app.log.1": false, "/etc/passwd": false, "/var/log": false,
	} {
		if got := PathAllowed(path, allowed); got != want {
			t.Errorf("%s: got %v want %v", path, got, want)
		}
	}
}

// The file source tails a file under GLIMT_LOG_PATHS with tail -F semantics:
// existing lines, new lines, and the new file after a rotation.
func TestFileOpenerTailsAndFollowsRotation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	if err := os.WriteFile(path, []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	open := FileOpener([]string{" " + dir + " "})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := make(chan protocol.LogLine, 16)
	done := make(chan error, 1)
	go func() { done <- open(ctx, protocol.LogStart{Source: "file", Path: path, Tail: 10}, out) }()

	next := func(want string) {
		t.Helper()
		select {
		case l := <-out:
			if l.Message != want {
				t.Errorf("got %q want %q", l.Message, want)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("no line %q", want)
		}
	}
	next("one")
	next("two")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString("three\n")
	f.Close()
	next("three")
	// Rotation: the old file is renamed and a new one appears at the path.
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("after\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	next("after")
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("tail did not stop")
	}
}

func TestFileOpenerRejectsOtherPaths(t *testing.T) {
	dir := t.TempDir()
	out := make(chan protocol.LogLine, 1)
	cases := []struct {
		name    string
		allowed []string
		path    string
	}{
		{"nothing configured", nil, filepath.Join(dir, "a.log")},
		{"outside the allowed dirs", []string{dir}, "/etc/passwd"},
		{"dot-dot escape", []string{dir}, filepath.Join(dir, "..", "x.log")},
		{"missing file", []string{dir}, filepath.Join(dir, "missing.log")},
	}
	for _, c := range cases {
		err := FileOpener(c.allowed)(context.Background(), protocol.LogStart{Source: "file", Path: c.path}, out)
		if !errors.Is(err, ErrUnavailable) {
			t.Errorf("%s: err = %v, want ErrUnavailable", c.name, err)
		}
	}
	if err := FileOpener([]string{dir})(context.Background(), protocol.LogStart{Source: "file"}, out); err == nil || errors.Is(err, ErrUnavailable) {
		t.Errorf("empty path: %v", err)
	}
}
