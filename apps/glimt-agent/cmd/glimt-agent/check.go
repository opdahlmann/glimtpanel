package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/collect"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/docker"
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
	lookup := func(name string) string {
		if v := os.Getenv(name); v != "" {
			return v
		}
		return fileEnv[name]
	}
	o, code, ok := parseOptions("check", args, stderr, lookup)
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
	p("hostname:        %s", info.Hostname)
	p("os:              %s (%s %s), kernel %s, %s, %d cores, %s RAM", info.OS.PrettyName, info.OS.ID, info.OS.VersionID, info.Kernel, info.Arch, info.Cores, humanBytes(info.RAMBytes))

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
	journal := fileExists("/run/systemd/journal/socket") || dirExists("/run/log/journal") || dirExists("/var/log/journal")
	if path, err := exec.LookPath("journalctl"); err == nil {
		p("journald:        %s (journalctl at %s)", yes(journal), path)
	} else {
		p("journald:        %s (journalctl not in PATH)", yes(journal))
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
	api, err := docker.NewClient(ep, 2*time.Second).Ping(ctx)
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return fmt.Sprintf("%s: present, permission denied", ep)
		}
		return fmt.Sprintf("%s: unreachable (%v)", ep, shortErr(err))
	}
	if api == "" {
		api = "unknown"
	}
	return fmt.Sprintf("%s: reachable, API %s", ep, api)
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
