// Package state persists the agent token in the state directory
// (/var/lib/glimt-agent, or $STATE_DIRECTORY under systemd).
package state

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const tokenFile = "token"

// Store keeps the token at <dir>/token with mode 0600.
type Store struct {
	dir string
}

// New returns a store for dir. The directory is created on first Save.
func New(dir string) *Store { return &Store{dir: dir} }

// Dir returns the state directory.
func (s *Store) Dir() string { return s.dir }

// Path returns the token file path.
func (s *Store) Path() string { return filepath.Join(s.dir, tokenFile) }

// Load returns the stored token, or "" when none is stored.
func (s *Store) Load() (string, error) {
	data, err := os.ReadFile(s.Path())
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("state: read token: %w", err)
	}
	return strings.TrimSpace(string(data)), nil
}

// Save writes the token atomically (temp file + rename) with mode 0600.
func (s *Store) Save(token string) error {
	if strings.TrimSpace(token) == "" {
		return errors.New("state: refusing to save empty token")
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return fmt.Errorf("state: create %s: %w", s.dir, err)
	}
	tmp, err := os.CreateTemp(s.dir, tokenFile+".*.tmp")
	if err != nil {
		return fmt.Errorf("state: create temp file: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("state: chmod: %w", err)
	}
	if _, err := tmp.WriteString(token + "\n"); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("state: write: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("state: sync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("state: close: %w", err)
	}
	if err := os.Rename(tmpName, s.Path()); err != nil {
		cleanup()
		return fmt.Errorf("state: rename: %w", err)
	}
	if d, err := os.Open(s.dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// Clear removes the stored token. It is not an error if none exists.
func (s *Store) Clear() error {
	err := os.Remove(s.Path())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("state: remove token: %w", err)
	}
	return nil
}
