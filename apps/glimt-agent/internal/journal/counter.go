package journal

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"regexp"
	"sync"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/collect"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// Counter implements collect.CountsProvider from the journal. Refresh runs
// three journalctl queries over the last 24 hours; SecurityCounts returns
// the cached result. The scheduler refreshes on the maintenance tick.
type Counter struct {
	run Runner
	log *slog.Logger
	now func() time.Time

	mu     sync.Mutex
	counts collect.SecurityCounts
	at     time.Time
	err    error
}

// NewCounter builds a Counter; run and now may be nil.
func NewCounter(logger *slog.Logger, run Runner, now func() time.Time) *Counter {
	if logger == nil {
		logger = slog.Default()
	}
	if run == nil {
		run = execRunner
	}
	if now == nil {
		now = time.Now
	}
	return &Counter{run: run, log: logger, now: now}
}

// Matches sshd's failed-login messages. Both real sshd (_COMM=sshd, unit
// ssh.service or sshd.service) and lines logged with "logger -t sshd" (the
// dev container's noise) carry SYSLOG_IDENTIFIER=sshd, so the query matches
// on that identifier as well as the unit names.
var (
	sshFailedRe  = regexp.MustCompile(`Failed password|Invalid user|authentication failure`)
	sshAttemptRe = regexp.MustCompile(`(?:for (?:invalid user )?|Invalid user )(\S+) from (\S+)`)
)

// SSHArgs is the journalctl query for failed SSH logins in the last 24 h.
var SSHArgs = []string{"-o", "json", "--no-pager", "-q", "--since=-24h",
	"_SYSTEMD_UNIT=ssh.service", "_SYSTEMD_UNIT=sshd.service", "+", "SYSLOG_IDENTIFIER=sshd"}

// UFWArgs counts kernel "UFW BLOCK" lines in the last 24 h.
var UFWArgs = []string{"-o", "cat", "--no-pager", "-q", "--since=-24h", "-k", "-g", "UFW BLOCK"}

// Fail2banArgs counts fail2ban bans in the last 24 h.
var Fail2banArgs = []string{"-o", "cat", "--no-pager", "-q", "--since=-24h", "-u", "fail2ban", "-g", " Ban "}

// Refresh recomputes the counts. A query that fails counts as zero; the
// joined error is returned and remembered (Err).
func (c *Counter) Refresh(ctx context.Context) error {
	now := c.now()
	var counts collect.SecurityCounts
	var errs []error

	if err := c.each(ctx, SSHArgs, func(b []byte) {
		line, ok := ParseLine(b)
		if !ok || !sshFailedRe.MatchString(line.Message) {
			return
		}
		at := time.UnixMilli(line.TS)
		if now.Sub(at) <= 24*time.Hour {
			counts.SSHFailedDay++
		}
		if now.Sub(at) <= time.Hour {
			counts.SSHFailedHour++
		}
		attempt := protocol.SSHAttempt{At: line.TS}
		if m := sshAttemptRe.FindStringSubmatch(line.Message); m != nil {
			attempt.User, attempt.From = m[1], m[2]
		}
		counts.SSHLast = append(counts.SSHLast, attempt)
		if len(counts.SSHLast) > 3 {
			counts.SSHLast = counts.SSHLast[len(counts.SSHLast)-3:]
		}
	}); err != nil {
		errs = append(errs, err)
	}
	if n, err := c.count(ctx, UFWArgs); err != nil {
		errs = append(errs, err)
	} else {
		counts.UFWBlocked = n
	}
	if n, err := c.count(ctx, Fail2banArgs); err != nil {
		errs = append(errs, err)
	} else {
		counts.Fail2banBanned = n
	}

	err := errors.Join(errs...)
	c.mu.Lock()
	c.counts, c.at, c.err = counts, now, err
	c.mu.Unlock()
	return err
}

// SecurityCounts returns the cached counts (zero before the first Refresh).
func (c *Counter) SecurityCounts(context.Context) collect.SecurityCounts {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := c.counts
	out.SSHLast = append([]protocol.SSHAttempt(nil), c.counts.SSHLast...)
	return out
}

func (c *Counter) each(ctx context.Context, args []string, fn func([]byte)) error {
	rc, err := c.run(ctx, args)
	if err != nil {
		return err
	}
	defer rc.Close()
	sc := bufio.NewScanner(rc)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		fn(sc.Bytes())
	}
	if err := sc.Err(); err != nil && !errors.Is(err, io.EOF) && ctx.Err() == nil {
		return err
	}
	return ctx.Err()
}

func (c *Counter) count(ctx context.Context, args []string) (int, error) {
	n := 0
	err := c.each(ctx, args, func(b []byte) {
		if len(b) > 0 {
			n++
		}
	})
	return n, err
}

// RefreshedAt returns when Refresh last ran (zero before the first).
func (c *Counter) RefreshedAt() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at
}

// Name identifies the counter in scheduler logs.
func (c *Counter) Name() string { return "journal counts" }
