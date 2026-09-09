package collect

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParsePasswd(t *testing.T) {
	users := parsePasswd(strings.NewReader(fixture(t, "etc/passwd")))
	if users[0] != "root" || users[991] != "systemd-resolve" || users[1000] != "ole" {
		t.Errorf("users = %v", users)
	}
	if len(users) != 4 {
		t.Errorf("%d users, want 4 (comment, broken and duplicate lines skipped)", len(users))
	}
}

func TestPasswdCacheRefresh(t *testing.T) {
	path := filepath.Join(t.TempDir(), "passwd")
	must(t, os.WriteFile(path, []byte("alice:x:501:501::/:/bin/sh\n"), 0o644))
	p := newPasswdCache(path)
	p.refresh(t0)
	if p.Lookup(501) != "alice" || p.Lookup(502) != "502" {
		t.Errorf("lookup = %q / %q", p.Lookup(501), p.Lookup(502))
	}
	// Same size and mtime within a minute → not re-read.
	must(t, os.WriteFile(path, []byte("bobby:x:502:502::/:/bin/sh\n"), 0o644))
	p.refresh(t0.Add(10 * time.Second))
	if p.Lookup(501) != "alice" {
		t.Error("should not re-read within a minute")
	}
	// After a minute the changed file is picked up.
	future := time.Now().Add(time.Hour)
	must(t, os.Chtimes(path, future, future))
	p.refresh(t0.Add(2 * time.Minute))
	if p.Lookup(502) != "bobby" || p.Lookup(501) != "501" {
		t.Errorf("after change: %q / %q", p.Lookup(502), p.Lookup(501))
	}
	missing := newPasswdCache(filepath.Join(t.TempDir(), "none"))
	missing.refresh(t0)
	if missing.Lookup(0) != "0" {
		t.Error("missing passwd falls back to numbers")
	}
}
