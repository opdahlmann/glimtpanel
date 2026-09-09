package collect

import (
	"context"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// Options configure NewSystem. Zero values mean defaults.
type Options struct {
	TopProcesses int            // default 40
	ProcRoot     string         // default "/proc" (tests use fixtures)
	SysRoot      string         // default "/sys"
	EtcRoot      string         // default "/etc"
	VarRoot      string         // default "/var"
	Runner       CommandRunner  // executes external commands; default exec-based; tests inject fakes
	Counts       CountsProvider // journal-based counts for the security section; may be nil
	Logger       *slog.Logger
}

// System is the facade the scheduler uses. All methods are safe for
// concurrent use and never panic; what could not be read is left at its zero
// value and reported in the error where that matters.
type System interface {
	// Host: cpu (total, user, system, iowait, steal, perCore), load, mem, uptimeSec, mounts (with inodes and read/write Bps), ifaces (ips, rx/tx Bps).
	// Rates need two samples: the first call returns 0 rates; keep state between calls.
	Host(ctx context.Context) (protocol.Host, error)
	// Processes: union of top N by CPU and top N by RSS, each with both numbers; totals from /proc/stat + count.
	Processes(ctx context.Context, topN int) ([]protocol.Process, protocol.ProcessTotals, error)
	Services(ctx context.Context) (*protocol.Services, error)
	Maintenance(ctx context.Context) (*protocol.Maintenance, error)
	Security(ctx context.Context) (*protocol.Security, error)
}

// NewSystem builds the facade. Nothing is read until the first call.
func NewSystem(o Options) System {
	o = o.withDefaults()
	log := o.Logger
	return &system{
		o:           o,
		log:         log,
		now:         time.Now,
		host:        newHostCollector(o.ProcRoot, newDiskCollector(o.ProcRoot, o.SysRoot, log), newNetCollector(o.ProcRoot, log)),
		procs:       newProcCollector(o.ProcRoot, o.EtcRoot, log),
		needrestart: &needrestartCache{runner: o.Runner, log: log},
		warn:        &warnLimiter{log: log, every: time.Hour},
	}
}

func (o Options) withDefaults() Options {
	if o.TopProcesses <= 0 {
		o.TopProcesses = 40
	}
	if o.ProcRoot == "" {
		o.ProcRoot = "/proc"
	}
	if o.SysRoot == "" {
		o.SysRoot = "/sys"
	}
	if o.EtcRoot == "" {
		o.EtcRoot = "/etc"
	}
	if o.VarRoot == "" {
		o.VarRoot = "/var"
	}
	if o.Runner == nil {
		o.Runner = ExecRunner{}
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	return o
}

type system struct {
	o           Options
	log         *slog.Logger
	now         func() time.Time
	host        *HostCollector
	procs       *procCollector
	needrestart *needrestartCache
	warn        *warnLimiter
}

func (s *system) Host(ctx context.Context) (protocol.Host, error) {
	return s.host.HostContext(ctx)
}

func (s *system) Processes(ctx context.Context, topN int) ([]protocol.Process, protocol.ProcessTotals, error) {
	if topN <= 0 {
		topN = s.o.TopProcesses
	}
	return s.procs.Collect(ctx, topN)
}

// warnLimiter logs a warning at most once per interval per key, so a
// permanently missing tool does not flood the journal every snapshot.
type warnLimiter struct {
	log   *slog.Logger
	every time.Duration
	now   func() time.Time
	mu    sync.Mutex
	last  map[string]time.Time
}

func (w *warnLimiter) Warn(key, msg string, args ...any) {
	now := time.Now
	if w.now != nil {
		now = w.now
	}
	t := now()
	w.mu.Lock()
	if w.last == nil {
		w.last = map[string]time.Time{}
	}
	prev, seen := w.last[key]
	if seen && t.Sub(prev) < w.every {
		w.mu.Unlock()
		w.log.Debug(msg, args...)
		return
	}
	w.last[key] = t
	w.mu.Unlock()
	w.log.Warn(msg, args...)
}

// fileExists reports whether path exists (any type).
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
