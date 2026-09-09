package state

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSaveLoadClear(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "state")
	s := New(dir)

	tok, err := s.Load()
	if err != nil || tok != "" {
		t.Fatalf("empty store: tok=%q err=%v", tok, err)
	}

	if err := s.Save("agt_c0ffee1234567890abcdef"); err != nil {
		t.Fatal(err)
	}
	tok, err = s.Load()
	if err != nil || tok != "agt_c0ffee1234567890abcdef" {
		t.Fatalf("after save: tok=%q err=%v", tok, err)
	}
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(s.Path())
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("token mode = %o, want 600", fi.Mode().Perm())
		}
	}

	// Overwrite (rotate) leaves no temp files behind.
	if err := s.Save("agt_second_token_0123456789"); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("expected only the token file, got %d entries", len(entries))
	}
	tok, _ = s.Load()
	if tok != "agt_second_token_0123456789" {
		t.Errorf("rotate: tok=%q", tok)
	}

	if err := s.Clear(); err != nil {
		t.Fatal(err)
	}
	if err := s.Clear(); err != nil {
		t.Errorf("second clear should be a no-op: %v", err)
	}
	tok, err = s.Load()
	if err != nil || tok != "" {
		t.Fatalf("after clear: tok=%q err=%v", tok, err)
	}
}

func TestSaveEmptyRejected(t *testing.T) {
	s := New(t.TempDir())
	if err := s.Save("  "); err == nil {
		t.Error("empty token must be rejected")
	}
}
