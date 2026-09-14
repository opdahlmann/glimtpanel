package logs

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/docker"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/journal"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// JournalOpener streams the journal sources through journalctl.
func JournalOpener(j *journal.Journal) Opener {
	return func(ctx context.Context, req protocol.LogStart, out chan<- protocol.LogLine) error {
		return j.Stream(ctx, journal.StreamRequest{Source: req.Source, Unit: req.Unit, Priority: req.Priority, SinceMs: req.SinceMs, Tail: req.Tail}, out)
	}
}

// WebOpener tails the readable web server logs (journal.WebLogPaths).
func WebOpener(paths []string) Opener {
	return func(ctx context.Context, req protocol.LogStart, out chan<- protocol.LogLine) error {
		readable := journal.ReadablePaths(paths)
		if len(readable) == 0 {
			return fmt.Errorf("%w: no readable web server log (looked for %v)", ErrUnavailable, paths)
		}
		return journal.Tail(ctx, readable, req.Tail, true, out, journal.TailOptions{})
	}
}

// FileOpener tails one file from logStart.path with tail -F semantics
// (fase 12). Only paths listed in allowed (GLIMT_LOG_PATHS), or under a
// listed directory, are served; anything else is refused.
func FileOpener(allowed []string) Opener {
	var clean []string
	for _, p := range allowed {
		if p = strings.TrimSpace(p); p != "" {
			clean = append(clean, filepath.Clean(p))
		}
	}
	return func(ctx context.Context, req protocol.LogStart, out chan<- protocol.LogLine) error {
		if len(clean) == 0 {
			return fmt.Errorf("%w: no log files configured (GLIMT_LOG_PATHS)", ErrUnavailable)
		}
		if req.Path == "" {
			return errors.New("logStart without path")
		}
		path := filepath.Clean(req.Path)
		if !PathAllowed(path, clean) {
			return fmt.Errorf("%w: %s is not in GLIMT_LOG_PATHS", ErrUnavailable, path)
		}
		if len(journal.ReadablePaths([]string{path})) == 0 {
			return fmt.Errorf("%w: %s is not readable", ErrUnavailable, path)
		}
		return journal.Tail(ctx, []string{path}, req.Tail, true, out, journal.TailOptions{})
	}
}

// PathAllowed reports whether path is one of allowed or lies under an allowed directory.
func PathAllowed(path string, allowed []string) bool {
	for _, a := range allowed {
		if path == a || strings.HasPrefix(path, a+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// ContainerOpener follows a container's logs; nil engine means Docker is off.
func ContainerOpener(e *docker.Engine) Opener {
	return func(ctx context.Context, req protocol.LogStart, out chan<- protocol.LogLine) error {
		if e == nil {
			return fmt.Errorf("%w: docker access is off (--docker none)", ErrUnavailable)
		}
		if req.Container == "" {
			return errors.New("logStart without container")
		}
		return e.Logs(ctx, req.Container, req.Tail, req.SinceMs, out)
	}
}
