package logs

import (
	"context"
	"errors"
	"fmt"

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
