// Package journal reads systemd's journal through journalctl: live streams
// for the log sources, tail of web server log files, and the counters the
// security section needs (failed SSH logins, UFW blocks, fail2ban bans).
package journal

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// ErrUnavailable means journalctl is not installed or cannot be run here.
var ErrUnavailable = errors.New("journal: journalctl is not available")

// Sources the journal package serves (logStart.source).
const (
	SourceJournal  = "journal"
	SourceAuth     = "auth"
	SourceKernel   = "kernel"
	SourcePackages = "packages"
	SourceFirewall = "firewall"
	SourceWeb      = "web"
)

// StreamRequest is a logStart reduced to what journalctl needs.
type StreamRequest struct {
	Source   string
	Unit     string
	Priority string // err | warn | info | ""
	SinceMs  int64
	Tail     int
}

// Runner starts a journalctl process and returns its stdout. The returned
// closer must stop the process and reap it. Tests replace it.
type Runner func(ctx context.Context, args []string) (io.ReadCloser, error)

// Journal spawns journalctl.
type Journal struct {
	run Runner
	log *slog.Logger
	// MaxLine caps one journal entry; longer messages are cut. Default 64 KiB.
	MaxLine int
}

// New returns a Journal that runs the real journalctl. Runner may be nil.
func New(logger *slog.Logger, run Runner) *Journal {
	if logger == nil {
		logger = slog.Default()
	}
	if run == nil {
		run = execRunner
	}
	return &Journal{run: run, log: logger, MaxLine: 64 << 10}
}

// Available reports whether journalctl can be found.
func Available() bool {
	_, err := exec.LookPath("journalctl")
	return err == nil
}

// Args builds the journalctl argument lists for a request; the firewall
// source needs two processes (see below), every other source one. The
// common prefix "-o json --no-pager" is included.
//
// Match syntax: alternatives on the same field OR automatically, "+"
// ORs whole terms across fields; flags such as -k, -u and -p are ANDed with
// the terms. The firewall source wants kernel messages mentioning UFW as
// well as everything fail2ban-server logs; -g applies to the whole output,
// so that becomes two processes: "-k -g UFW" and "_COMM=fail2ban-server".
// Each gets half of tail so the merged prelude stays within the request.
func Args(req StreamRequest) ([][]string, error) {
	base := []string{"-o", "json", "--no-pager"}
	if req.Priority != "" {
		p, err := priorityArg(req.Priority)
		if err != nil {
			return nil, err
		}
		base = append(base, "-p", p)
	}
	if req.SinceMs > 0 {
		base = append(base, "--since=@"+strconv.FormatInt(req.SinceMs/1000, 10))
	}
	if req.Unit != "" {
		if strings.ContainsAny(req.Unit, " \t\n") || strings.HasPrefix(req.Unit, "-") {
			return nil, fmt.Errorf("journal: invalid unit %q", req.Unit)
		}
		base = append(base, "-u", req.Unit)
	}
	tail := req.Tail
	if tail < 0 {
		tail = 0
	}
	withTail := func(n int, extra ...string) []string {
		args := append([]string{}, base...)
		args = append(args, "-n", strconv.Itoa(n), "-f")
		return append(args, extra...)
	}
	switch req.Source {
	case SourceJournal, "":
		return [][]string{withTail(tail)}, nil
	case SourceAuth:
		return [][]string{withTail(tail, "_COMM=sshd", "_COMM=sudo", "_COMM=su", "+", "SYSLOG_IDENTIFIER=systemd-logind", "+", "SYSLOG_IDENTIFIER=sshd")}, nil
	case SourceKernel:
		return [][]string{withTail(tail, "-k")}, nil
	case SourcePackages:
		return [][]string{withTail(tail, "_COMM=apt", "_COMM=apt-get", "_COMM=dpkg", "_COMM=unattended-upgrade", "+", "SYSLOG_IDENTIFIER=unattended-upgrades")}, nil
	case SourceFirewall:
		half := (tail + 1) / 2
		return [][]string{withTail(half, "-k", "-g", "UFW"), withTail(half, "_COMM=fail2ban-server")}, nil
	}
	return nil, fmt.Errorf("journal: source %q is not a journal source", req.Source)
}

func priorityArg(p string) (string, error) {
	switch p {
	case "err":
		return "0..3", nil
	case "warn":
		return "4..4", nil
	case "info":
		return "5..7", nil
	}
	return "", fmt.Errorf("journal: unknown priority %q", p)
}

// Stream runs journalctl for req and sends parsed lines to out until ctx
// ends (returns ctx.Err()) or every process exits (nil). The processes are
// killed and reaped when ctx ends.
func (j *Journal) Stream(ctx context.Context, req StreamRequest, out chan<- protocol.LogLine) error {
	argSets, err := Args(req)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	errs := make(chan error, len(argSets))
	for _, args := range argSets {
		rc, err := j.run(ctx, args)
		if err != nil {
			cancel()
			wg.Wait()
			return err
		}
		wg.Add(1)
		go func(rc io.ReadCloser) {
			defer wg.Done()
			defer rc.Close()
			errs <- j.pump(ctx, rc, out)
		}(rc)
	}
	wg.Wait()
	close(errs)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	for err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

// pump parses JSON lines from r into out.
func (j *Journal) pump(ctx context.Context, r io.Reader, out chan<- protocol.LogLine) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), j.MaxLine+4096)
	for sc.Scan() {
		line, ok := ParseLine(sc.Bytes())
		if !ok {
			continue
		}
		if j.MaxLine > 0 && len(line.Message) > j.MaxLine {
			line.Message = line.Message[:j.MaxLine]
		}
		select {
		case out <- line:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err := sc.Err(); err != nil && ctx.Err() == nil {
		return err
	}
	return nil
}

// execRunner starts journalctl in its own process group so that the whole
// group is killed when ctx ends; Close waits for the exit (no zombies).
func execRunner(ctx context.Context, args []string) (io.ReadCloser, error) {
	path, err := exec.LookPath("journalctl")
	if err != nil {
		return nil, ErrUnavailable
	}
	return startProcess(ctx, path, args)
}

// process is a running journalctl: its stdout plus the wait.
type process struct {
	cmd  *exec.Cmd
	out  io.ReadCloser
	once sync.Once
	kill func()
}

func (p *process) Read(b []byte) (int, error) { return p.out.Read(b) }

// Close terminates the process and reaps it. Safe to call twice.
func (p *process) Close() error {
	p.once.Do(func() {
		p.kill()
		_ = p.out.Close()
		_ = p.cmd.Wait()
	})
	return nil
}

func startProcess(ctx context.Context, path string, args []string) (io.ReadCloser, error) {
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stderr = io.Discard
	cmd.Env = []string{"LC_ALL=C", "PATH=/usr/bin:/bin"}
	setProcessGroup(cmd)
	cmd.WaitDelay = 2 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return nil, ErrUnavailable
		}
		return nil, err
	}
	p := &process{cmd: cmd, out: stdout}
	p.kill = func() { killGroup(cmd) }
	cmd.Cancel = func() error { killGroup(cmd); return nil }
	return p, nil
}
