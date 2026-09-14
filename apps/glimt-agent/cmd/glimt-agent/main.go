// Command glimt-agent is the Glimtpanel agent: a read-only collector that
// sends host metrics, containers, services, security state and logs to the
// hub over one WebSocket.
//
// Subcommands: run (default), check, snapshot, stream, logs, version, uninstall.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/logs"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/sched"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/sdnotify"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/state"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/sysinfo"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/ws"
)

// version is set at build time with -ldflags "-X main.version=…".
var version = "0.0.0-dev"

const (
	defaultStateDir = "/var/lib/glimt-agent"
	defaultProxyURL = "tcp://127.0.0.1:2375"
)

// options are shared by run and check. Flags win over environment variables.
type options struct {
	hub       string
	key       string
	name      string
	docker    string
	proxyURL  string
	stateDir  string
	heartbeat int
	logLevel  string

	// Fase 12: container nodes. kind is resolved from auto to server or
	// container by applyEnv; kindReasons say why (for check).
	kind        string
	kindReasons []string
	token       string // GLIMT_TOKEN: the long-lived node token
	healthURL   string // GLIMT_HEALTH_URL
	checks      string // GLIMT_CHECKS
	logPaths    string // GLIMT_LOG_PATHS
	image       string // GLIMT_IMAGE
}

func bindFlags(fs *flag.FlagSet, o *options) {
	fs.StringVar(&o.hub, "hub", "", "hub WebSocket URL, e.g. wss://api.glimtpanel.com/agent/ws (env GLIMT_HUB)")
	fs.StringVar(&o.key, "key", "", "enrolment key gp_…, used only until a token is stored (env GLIMT_AGENT_KEY)")
	fs.StringVar(&o.name, "name", "", "hostname to report instead of the system hostname (env GLIMT_AGENT_NAME)")
	fs.StringVar(&o.docker, "docker", "none", "container access: none | socket | proxy (env GLIMT_AGENT_DOCKER)")
	fs.StringVar(&o.proxyURL, "proxy-url", defaultProxyURL, "docker-socket-proxy address for --docker proxy (env GLIMT_AGENT_PROXY_URL)")
	fs.StringVar(&o.stateDir, "state-dir", defaultStateDir, "where the token is stored (env STATE_DIRECTORY)")
	fs.IntVar(&o.heartbeat, "heartbeat", 30, "snapshot interval in seconds until the hub says otherwise (env GLIMT_HEARTBEAT_SECONDS)")
	fs.StringVar(&o.logLevel, "log-level", "info", "debug | info | warn | error (env GLIMT_LOG_LEVEL)")
	fs.StringVar(&o.kind, "kind", sysinfo.KindAuto, "auto | server | container: auto picks container inside one (env GLIMT_KIND)")
}

// detectRoot and detectProc are what the kind detection looks at; tests override them.
var detectRoot, detectProc = "/", "/proc"

// applyEnv fills in options that were not given as flags. lookup resolves an
// environment variable; nil means os.Getenv.
func applyEnv(fs *flag.FlagSet, o *options, lookup func(string) string) error {
	if lookup == nil {
		lookup = os.Getenv
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	env := func(names ...string) string {
		for _, n := range names {
			if v := strings.TrimSpace(lookup(n)); v != "" {
				return v
			}
		}
		return ""
	}
	if !set["hub"] {
		o.hub = env("GLIMT_HUB", "GLIMT_AGENT_HUB_WS")
	}
	if !set["key"] {
		o.key = env("GLIMT_AGENT_KEY", "GLIMT_DEV_ENROL_KEY")
	}
	if !set["name"] {
		o.name = env("GLIMT_AGENT_NAME", "GLIMT_NODE_NAME")
	}
	if !set["kind"] {
		if v := env("GLIMT_KIND"); v != "" {
			o.kind = v
		}
	}
	switch o.kind {
	case sysinfo.KindAuto, protocol.KindServer, protocol.KindContainer:
	default:
		return fmt.Errorf("--kind must be auto, server or container, got %q", o.kind)
	}
	o.kind, o.kindReasons = sysinfo.DetectKind(o.kind, detectRoot, detectProc, lookup)
	o.token = env("GLIMT_TOKEN")
	o.healthURL = env("GLIMT_HEALTH_URL")
	o.checks = env("GLIMT_CHECKS")
	o.logPaths = env("GLIMT_LOG_PATHS")
	o.image = env("GLIMT_IMAGE")
	if o.healthURL != "" && !strings.HasPrefix(o.healthURL, "http://") && !strings.HasPrefix(o.healthURL, "https://") {
		return fmt.Errorf("GLIMT_HEALTH_URL must start with http:// or https://, got %q", o.healthURL)
	}
	if !set["docker"] {
		if v := env("GLIMT_AGENT_DOCKER"); v != "" {
			o.docker = v
		}
	}
	if !set["proxy-url"] {
		if v := env("GLIMT_AGENT_PROXY_URL"); v != "" {
			o.proxyURL = v
		}
	}
	if !set["state-dir"] {
		if v := env("STATE_DIRECTORY"); v != "" {
			// systemd may pass several directories separated by ":"; the first is ours.
			o.stateDir = strings.Split(v, ":")[0]
		}
	}
	if !set["heartbeat"] {
		if v := env("GLIMT_HEARTBEAT_SECONDS"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 {
				return fmt.Errorf("GLIMT_HEARTBEAT_SECONDS=%q is not a positive integer", v)
			}
			o.heartbeat = n
		}
	}
	if !set["log-level"] {
		if v := env("GLIMT_LOG_LEVEL"); v != "" {
			o.logLevel = v
		}
	}
	switch o.docker {
	case protocol.DockerNone, protocol.DockerSocket, protocol.DockerProxy:
	default:
		return fmt.Errorf("--docker must be none, socket or proxy, got %q", o.docker)
	}
	if o.heartbeat < 1 {
		return errors.New("--heartbeat must be at least 1 second")
	}
	return nil
}

func newLogger(level string, w io.Writer) (*slog.Logger, error) {
	var lvl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "info", "":
		lvl = slog.LevelInfo
	case "warn", "warning":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		return nil, fmt.Errorf("unknown log level %q", level)
	}
	underJournal := os.Getenv("JOURNAL_STREAM") != ""
	h := slog.NewTextHandler(w, &slog.HandlerOptions{
		Level: lvl,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			// journald stamps its own time; keep lines short there.
			if underJournal && len(groups) == 0 && a.Key == slog.TimeKey {
				return slog.Attr{}
			}
			return a
		},
	})
	return slog.New(h), nil
}

func usage(w io.Writer) {
	fmt.Fprintf(w, `glimt-agent %s – Glimtpanel agent (read-only)

Usage:
  glimt-agent [run] [flags]      connect to the hub and keep reporting (default)
  glimt-agent check [flags]      show what this machine (or container) offers the agent
  glimt-agent snapshot [flags]   print one snapshot message as JSON (no hub needed)
  glimt-agent stream [flags]     print one stream message as JSON (no hub needed)
  glimt-agent logs [flags]       print a log source: --source journal|auth|kernel|packages|web|firewall|container
                                 [--unit X] [--container Y] [--priority err|warn|info] [--tail N] [--since 1h] [--follow]
  glimt-agent version            print the version
  glimt-agent uninstall [--dry-run]
                                 stop the service and remove unit, config, state and binary (root)

Run "glimt-agent <command> -h" for flags. snapshot, stream and logs read
/etc/glimt-agent/env for --docker when installed.

Inside a container (auto-detected, or --kind container) the agent reads
GLIMT_HUB, GLIMT_TOKEN, GLIMT_NODE_NAME, GLIMT_HEALTH_URL, GLIMT_CHECKS,
GLIMT_LOG_PATHS and GLIMT_IMAGE from the environment; no enrolment key.
`, version)
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	cmd := "run"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "run":
		return runAgent(args, stderr)
	case "version":
		fmt.Fprintf(stdout, "glimt-agent %s (%s/%s, %s)\n", version, runtime.GOOS, runtime.GOARCH, runtime.Version())
		return 0
	case "check":
		return runCheck(args, stdout, stderr)
	case "snapshot", "stream":
		return runOnce(cmd, args, stdout, stderr)
	case "logs":
		return runLogs(args, stdout, stderr)
	case "uninstall":
		return runUninstall(args, stdout, stderr)
	case "help", "-h", "--help":
		usage(stdout)
		return 0
	}
	fmt.Fprintf(stderr, "glimt-agent: unknown command %q\n\n", cmd)
	usage(stderr)
	return 2
}

func parseOptions(name string, args []string, stderr io.Writer, lookup func(string) string) (*options, int, bool) {
	fs := flag.NewFlagSet("glimt-agent "+name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	var o options
	bindFlags(fs, &o)
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil, 0, false
		}
		return nil, 2, false
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "glimt-agent %s: unexpected argument %q\n", name, fs.Arg(0))
		return nil, 2, false
	}
	if err := applyEnv(fs, &o, lookup); err != nil {
		fmt.Fprintf(stderr, "glimt-agent %s: %v\n", name, err)
		return nil, 2, false
	}
	return &o, 0, true
}

func runAgent(args []string, stderr io.Writer) int {
	o, code, ok := parseOptions("run", args, stderr, nil)
	if !ok {
		return code
	}
	log, err := newLogger(o.logLevel, stderr)
	if err != nil {
		fmt.Fprintf(stderr, "glimt-agent: %v\n", err)
		return 2
	}
	if o.hub == "" {
		log.Error("no hub URL: use --hub or GLIMT_HUB")
		return 2
	}

	var store ws.TokenStore = state.New(o.stateDir)
	if o.kind == protocol.KindContainer {
		// The node token lives in the environment; the state directory is
		// only used when it exists (an optional volume).
		store = &envStore{token: o.token, fallback: state.New(o.stateDir)}
		o.key = ""
	}
	token, err := store.Load()
	if err != nil {
		log.Error("cannot read state", "err", err, "dir", o.stateDir)
		return 1
	}
	if token == "" && o.key == "" {
		if o.kind == protocol.KindContainer {
			log.Error("no node token: set GLIMT_TOKEN (from «Add container» in the dashboard)", "kind", o.kind)
		} else {
			log.Error("no token stored and no enrolment key: use --key or GLIMT_AGENT_KEY", "stateDir", o.stateDir)
		}
		return 2
	}

	info := sysinfo.Collect()
	if o.name != "" {
		info.Hostname = o.name
	}
	log.Info("glimt-agent starting", "version", version, "kind", o.kind, "why", strings.Join(o.kindReasons, "; "), "hostname", info.Hostname, "os", info.OS.PrettyName,
		"kernel", info.Kernel, "arch", info.Arch, "cores", info.Cores, "docker", o.docker, "stateDir", o.stateDir,
		"auth", map[bool]string{true: "token", false: "enrolKey"}[token != ""])

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	d := buildDeps(ctx, o, log)
	heartbeat := time.Duration(o.heartbeat) * time.Second
	// current is the scheduler of the live connection; Docker events reach it.
	var current atomic.Pointer[sched.Scheduler]

	client, err := ws.New(ws.Config{
		HubURL:    o.hub,
		EnrolKey:  o.key,
		Store:     store,
		Logger:    log,
		UserAgent: "glimt-agent/" + version,
		Bye:       o.kind == protocol.KindContainer,
		Hello: func() protocol.Hello {
			return buildHello(o, info, d)
		},
		NewSession: func(ctx context.Context, w *protocol.Welcome, out ws.Sender) ws.Session {
			snap := heartbeat
			if w.SnapshotInterval >= 1000 {
				snap = time.Duration(w.SnapshotInterval) * time.Millisecond
			}
			var maint time.Duration
			if w.MaintenanceInterval >= 60000 {
				maint = time.Duration(w.MaintenanceInterval) * time.Millisecond
			}
			s := sched.New(d.schedConfig(out, snap, maint))
			lm := logs.New(d.logsConfig(out))
			current.Store(s)
			go s.Run(ctx)
			go func() {
				<-ctx.Done()
				current.CompareAndSwap(s, nil)
				lm.StopAll()
			}()
			return &session{sched: s, logs: lm, ctx: ctx}
		},
	})
	if err != nil {
		log.Error("invalid configuration", "err", err)
		return 2
	}
	if d.engine != nil {
		go d.engine.WatchEvents(ctx, func() {
			if s := current.Load(); s != nil {
				s.DockerChanged()
			}
		})
	}

	if err := sdnotify.Ready(); err != nil {
		log.Warn("sd_notify READY failed", "err", err)
	}
	_ = sdnotify.Status("connecting to " + o.hub)
	// Child processes (systemctl, journalctl, apt-get) must not inherit the
	// notify socket: systemd logs a warning for every message from a non-main
	// PID. The variable comes back for STOPPING=1.
	notifySocket := os.Getenv("NOTIFY_SOCKET")
	_ = os.Unsetenv("NOTIFY_SOCKET")

	err = client.Run(ctx)
	if notifySocket != "" {
		_ = os.Setenv("NOTIFY_SOCKET", notifySocket)
	}
	_ = sdnotify.Stopping()
	if err != nil {
		log.Error("agent stopped with error", "err", err)
		return 1
	}
	log.Info("glimt-agent stopped")
	return 0
}

// buildHello is the static part of hello for either profile.
func buildHello(o *options, info sysinfo.Info, d *deps) protocol.Hello {
	h := protocol.Hello{
		Hostname: info.Hostname, AgentVersion: version, OS: info.OS, Kernel: info.Kernel, Arch: info.Arch,
		Cores: info.Cores, RAMBytes: info.RAMBytes, BootTime: info.BootTime, DockerMode: d.dockerMode(),
	}
	if d.container != nil {
		h.Kind = protocol.KindContainer
		h.ContainerID = sysinfo.ContainerID(detectProc, info.Hostname)
		h.Capabilities = d.capabilities()
		h.Image = o.image
		h.LogPaths = d.logPaths
		h.Cores = d.container.Cores()
		if ram := d.container.RAMBytes(); ram > 0 {
			h.RAMBytes = ram
		}
	}
	return h
}

// envStore is the container profile's token store: the token comes from
// GLIMT_TOKEN at every start; the state directory is written only when it
// already exists (a volume the operator chose to mount).
type envStore struct {
	token    string
	fallback *state.Store
}

func (s *envStore) Load() (string, error) {
	if s.token != "" {
		return s.token, nil
	}
	return s.fallback.Load()
}

func (s *envStore) Save(token string) error {
	if fi, err := os.Stat(s.fallback.Dir()); err != nil || !fi.IsDir() {
		return nil
	}
	return s.fallback.Save(token)
}

func (s *envStore) Clear() error {
	s.token = ""
	if fi, err := os.Stat(s.fallback.Dir()); err != nil || !fi.IsDir() {
		return nil
	}
	return s.fallback.Clear()
}

// session is one connection's scheduler and log streams (ws.Session).
type session struct {
	sched *sched.Scheduler
	logs  *logs.Manager
	ctx   context.Context
}

func (s *session) Subscribe(interval time.Duration, topProcs int) {
	s.sched.Subscribe(interval, topProcs)
}
func (s *session) Unsubscribe()                   { s.sched.Unsubscribe() }
func (s *session) LogStart(req protocol.LogStart) { s.logs.Start(s.ctx, req) }
func (s *session) LogStop(id string)              { s.logs.Stop(id) }
