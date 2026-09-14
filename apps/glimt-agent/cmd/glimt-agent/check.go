package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/collect"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/docker"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/journal"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/state"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/sysinfo"
)

// configFile is what install.sh writes and systemd loads for the service.
const configFile = "/etc/glimt-agent/env"

// runCheck prints what this machine offers the agent. It changes nothing.
// Variables from /etc/glimt-agent/env (when readable) fill in behind the
// process environment, so the output reflects the installed configuration.
func runCheck(args []string, stdout, stderr io.Writer) int {
	fileEnv := readEnvFile(configFile)
	o, code, ok := parseOptions("check", args, stderr, fileLookup())
	if !ok {
		return code
	}
	p := func(format string, a ...any) { fmt.Fprintf(stdout, format+"\n", a...) }
	yes := func(b bool) string {
		if b {
			return "yes"
		}
		return "no"
	}

	info := sysinfo.Collect()
	if o.name != "" {
		info.Hostname = o.name
	}
	p("glimt-agent %s check", version)
	p("kind:            %s (%s)", o.kind, strings.Join(o.kindReasons, ", "))
	p("hostname:        %s", info.Hostname)
	p("os:              %s (%s %s), kernel %s, %s, %d cores, %s RAM", info.OS.PrettyName, info.OS.ID, info.OS.VersionID, info.Kernel, info.Arch, info.Cores, humanBytes(info.RAMBytes))

	if o.kind == protocol.KindContainer {
		checkContainer(p, yes, o)
		return 0
	}

	host, err := collect.NewHost().Host()
	switch {
	case err != nil && host.Mem.Total == 0:
		p("/proc:           not readable (%v)", err)
	case err != nil:
		p("/proc:           partly readable (%v)", err)
	default:
		p("/proc:           readable (mem used %s of %s, load %.2f, uptime %s)", humanBytes(host.Mem.Used), humanBytes(host.Mem.Total), first(host.Load), humanDuration(host.UptimeSec))
	}

	p("systemd:         %s", map[bool]string{true: "running", false: "not running"}[dirExists("/run/systemd/system")])
	haveJournal := fileExists("/run/systemd/journal/socket") || dirExists("/run/log/journal") || dirExists("/var/log/journal")
	if path, err := exec.LookPath("journalctl"); err == nil {
		p("journald:        %s (journalctl at %s)", yes(haveJournal), path)
		p("journal counts:  %s", journalCounts())
	} else {
		p("journald:        %s (journalctl not in PATH)", yes(haveJournal))
		p("journal counts:  unavailable (sshFailed, ufw and fail2ban counts need journalctl)")
	}
	if web := journal.ReadablePaths(journal.WebLogPaths); len(web) > 0 {
		p("web logs:        %s", strings.Join(web, ", "))
	} else {
		p("web logs:        none readable (%s)", strings.Join(journal.WebLogPaths, ", "))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	p("docker socket:   %s", probeDocker(ctx, docker.DefaultSocket))
	p("docker proxy:    %s", probeDocker(ctx, o.proxyURL))
	dockerSrc := "--docker / GLIMT_AGENT_DOCKER"
	if len(fileEnv) > 0 {
		dockerSrc += " / " + configFile
	}
	p("docker mode:     %s (from %s)", o.docker, dockerSrc)

	if path, err := exec.LookPath("needrestart"); err == nil {
		p("needrestart:     yes (%s)", path)
	} else {
		p("needrestart:     no")
	}
	for _, tool := range []string{"ufw", "fail2ban-client", "apt-get"} {
		if path, err := exec.LookPath(tool); err == nil {
			p("%-16s yes (%s)", tool+":", path)
		} else {
			p("%-16s no", tool+":")
		}
	}

	st := state.New(o.stateDir)
	tok, err := st.Load()
	tokenState := "no token stored (will enrol with the key)"
	if err != nil {
		tokenState = "token not readable: " + err.Error()
	} else if tok != "" {
		tokenState = "token stored"
	}
	p("state dir:       %s (%s, %s)", o.stateDir, writable(o.stateDir), tokenState)
	p("hub:             %s", orNone(o.hub))
	return 0
}

// checkContainer prints what the container profile found (fase 12).
func checkContainer(p func(string, ...any), yes func(bool) string, o *options) {
	log := quietLog()
	sys := collect.NewContainerSystem(collect.ContainerOptions{Logger: log})
	caps := sys.Capabilities()
	p("container id:    %s", sysinfo.ContainerID(detectProc, ""))
	p("cgroup:          %s (dir %s)", yes(caps.Cgroup), orNone(sys.CgroupDir()))
	if l := sys.Limits(); l.CPUCores > 0 || l.MemBytes > 0 {
		p("limits:          %.2f cores, %s", l.CPUCores, humanBytes(l.MemBytes))
	} else {
		p("limits:          none readable")
	}
	p("processes:       %s (shared pid namespace)", map[bool]string{true: "all", false: "only the agent's own"}[caps.ProcAll])
	p("network:         %s", yes(caps.Netns))
	host, err := sys.Host(context.Background())
	if err != nil {
		p("host:            partly readable (%v)", err)
	}
	p("memory:          %s of %s%s", humanBytes(host.Mem.Used), humanBytes(host.Mem.Total), map[bool]string{true: " (approx, summed over processes)", false: ""}[host.Approx])
	p("mounts:          %d", len(host.Mounts))
	p("health url:      %s", orNone(o.healthURL))
	p("checks:          %s", orNone(o.checks))
	p("log paths:       %s", orNone(o.logPaths))
	p("image:           %s", orNone(o.image))
	p("token:           %s", map[bool]string{true: "GLIMT_TOKEN set", false: "GLIMT_TOKEN missing"}[o.token != ""])
	p("hub:             %s", orNone(o.hub))
}

func quietLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

// readEnvFile parses KEY=VALUE lines; missing or unreadable files give an empty map.
func readEnvFile(path string) map[string]string {
	out := map[string]string{}
	data, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		out[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), `"'`)
	}
	return out
}

// journalCounts runs the security counters once (bounded to five seconds).
func journalCounts() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := journal.NewCounter(nil, nil, nil)
	err := c.Refresh(ctx)
	n := c.SecurityCounts(ctx)
	summary := fmt.Sprintf("sshd failed logins 24h %d (last hour %d), ufw blocks %d, fail2ban bans %d", n.SSHFailedDay, n.SSHFailedHour, n.UFWBlocked, n.Fail2banBanned)
	if err != nil {
		return summary + " – partly failed: " + shortErr(err)
	}
	return summary
}

func probeDocker(ctx context.Context, endpoint string) string {
	ep, err := docker.ParseEndpoint(endpoint)
	if err != nil {
		return fmt.Sprintf("%s: %v", endpoint, err)
	}
	if ep.Network == "unix" {
		if _, err := os.Stat(ep.Address); err != nil {
			return fmt.Sprintf("%s: not present", ep)
		}
	}
	client := docker.NewClient(ep, 2*time.Second)
	api, err := client.Ping(ctx)
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return fmt.Sprintf("%s: present, permission denied", ep)
		}
		return fmt.Sprintf("%s: unreachable (%v)", ep, shortErr(err))
	}
	if api == "" {
		api = "unknown"
	}
	v, err := client.Negotiate(ctx)
	if err != nil {
		return fmt.Sprintf("%s: reachable, API %s, but %v", ep, api, shortErr(err))
	}
	engine := docker.NewEngine(docker.Options{Client: client})
	list, err := engine.List(ctx)
	if err != nil {
		return fmt.Sprintf("%s: reachable, API %s (Docker %s, min %s), container list failed: %v", ep, v.APIVersion, v.Version, v.MinAPIVersion, shortErr(err))
	}
	running := 0
	for _, c := range list {
		if c.State == "running" {
			running++
		}
	}
	return fmt.Sprintf("%s: reachable, API %s (Docker %s, min %s), %d containers (%d running)", ep, v.APIVersion, v.Version, v.MinAPIVersion, len(list), running)
}

func shortErr(err error) string {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err.Error()
	}
	s := err.Error()
	if len(s) > 80 {
		return s[:80] + "…"
	}
	return s
}

func dirExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func writable(dir string) string {
	if !dirExists(dir) {
		return "missing"
	}
	f, err := os.CreateTemp(dir, ".check-*")
	if err != nil {
		return "not writable"
	}
	_ = f.Close()
	_ = os.Remove(f.Name())
	return "writable"
}

func orNone(s string) string {
	if s == "" {
		return "(not configured)"
	}
	return s
}

func first(f []float64) float64 {
	if len(f) == 0 {
		return 0
	}
	return f[0]
}

func humanBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit && exp < 4; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(b)/float64(div), "KMGTP"[exp])
}

func humanDuration(sec int64) string {
	d := time.Duration(sec) * time.Second
	days := int(d.Hours()) / 24
	hours := int(d.Hours()) % 24
	mins := int(d.Minutes()) % 60
	switch {
	case days > 0:
		return fmt.Sprintf("%dd %dh", days, hours)
	case hours > 0:
		return fmt.Sprintf("%dh %dm", hours, mins)
	}
	return fmt.Sprintf("%dm", mins)
}
