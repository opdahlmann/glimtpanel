// Command glimt-agent is the Glimtpanel agent: a read-only collector that
// sends host metrics to the hub over one WebSocket.
//
// Subcommands: run (default), version, check, uninstall.
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
	"syscall"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/collect"
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
}

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
		o.name = env("GLIMT_AGENT_NAME")
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
  glimt-agent [run] [flags]   connect to the hub and keep reporting (default)
  glimt-agent check [flags]   show what this machine offers the agent
  glimt-agent version         print the version
  glimt-agent uninstall [--dry-run]
                              stop the service and remove unit, config, state and binary (root)

Run "glimt-agent run -h" or "glimt-agent check -h" for flags.
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

	store := state.New(o.stateDir)
	token, err := store.Load()
	if err != nil {
		log.Error("cannot read state", "err", err, "dir", o.stateDir)
		return 1
	}
	if token == "" && o.key == "" {
		log.Error("no token stored and no enrolment key: use --key or GLIMT_AGENT_KEY", "stateDir", o.stateDir)
		return 2
	}

	info := sysinfo.Collect()
	if o.name != "" {
		info.Hostname = o.name
	}
	log.Info("glimt-agent starting", "version", version, "hostname", info.Hostname, "os", info.OS.PrettyName,
		"kernel", info.Kernel, "arch", info.Arch, "cores", info.Cores, "docker", o.docker, "stateDir", o.stateDir,
		"auth", map[bool]string{true: "token", false: "enrolKey"}[token != ""])

	host := collect.NewHost()
	heartbeat := time.Duration(o.heartbeat) * time.Second

	client, err := ws.New(ws.Config{
		HubURL:    o.hub,
		EnrolKey:  o.key,
		Store:     store,
		Logger:    log,
		UserAgent: "glimt-agent/" + version,
		Hello: func() protocol.Hello {
			return protocol.Hello{
				Hostname: info.Hostname, AgentVersion: version, OS: info.OS, Kernel: info.Kernel, Arch: info.Arch,
				Cores: info.Cores, RAMBytes: info.RAMBytes, BootTime: info.BootTime, DockerMode: o.docker,
			}
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
			s := sched.New(sched.Config{SnapshotInterval: snap, MaintenanceInterval: maint, Collector: host, Sink: out, Logger: log})
			go s.Run(ctx)
			return s
		},
	})
	if err != nil {
		log.Error("invalid configuration", "err", err)
		return 2
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if err := sdnotify.Ready(); err != nil {
		log.Warn("sd_notify READY failed", "err", err)
	}
	_ = sdnotify.Status("connecting to " + o.hub)

	err = client.Run(ctx)
	_ = sdnotify.Stopping()
	if err != nil {
		log.Error("agent stopped with error", "err", err)
		return 1
	}
	log.Info("glimt-agent stopped")
	return 0
}
