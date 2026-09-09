package main

import (
	"bytes"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVersionAndHelp(t *testing.T) {
	var out, errb bytes.Buffer
	if code := run([]string{"version"}, &out, &errb); code != 0 || !strings.HasPrefix(out.String(), "glimt-agent ") {
		t.Errorf("version: code=%d out=%q", code, out.String())
	}
	out.Reset()
	if code := run([]string{"help"}, &out, &errb); code != 0 || !strings.Contains(out.String(), "uninstall") {
		t.Errorf("help: code=%d out=%q", code, out.String())
	}
	if code := run([]string{"bogus"}, &out, &errb); code != 2 {
		t.Errorf("unknown command: code=%d", code)
	}
}

func TestRunRequiresHubAndCredentials(t *testing.T) {
	t.Setenv("GLIMT_HUB", "")
	t.Setenv("GLIMT_AGENT_HUB_WS", "")
	t.Setenv("GLIMT_AGENT_KEY", "")
	t.Setenv("GLIMT_DEV_ENROL_KEY", "")
	var out, errb bytes.Buffer
	if code := run([]string{"run", "--state-dir", t.TempDir()}, &out, &errb); code != 2 || !strings.Contains(errb.String(), "no hub URL") {
		t.Errorf("code=%d err=%q", code, errb.String())
	}
	errb.Reset()
	if code := run([]string{"--hub", "ws://localhost:1/agent/ws", "--state-dir", t.TempDir()}, &out, &errb); code != 2 || !strings.Contains(errb.String(), "no token stored") {
		t.Errorf("code=%d err=%q", code, errb.String())
	}
	errb.Reset()
	if code := run([]string{"run", "--hub", "ws://x", "--key", "gp_x", "--docker", "podman", "--state-dir", t.TempDir()}, &out, &errb); code != 2 || !strings.Contains(errb.String(), "--docker") {
		t.Errorf("bad docker mode: code=%d err=%q", code, errb.String())
	}
}

func TestFlagsWinOverEnvAndAliases(t *testing.T) {
	t.Setenv("GLIMT_HUB", "")
	t.Setenv("GLIMT_AGENT_HUB_WS", "ws://alias/agent/ws")
	t.Setenv("GLIMT_AGENT_KEY", "")
	t.Setenv("GLIMT_DEV_ENROL_KEY", "gp_dev_local")
	t.Setenv("GLIMT_HEARTBEAT_SECONDS", "7")
	t.Setenv("STATE_DIRECTORY", "/var/lib/glimt-agent:/other")
	t.Setenv("GLIMT_AGENT_NAME", "")

	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	var o options
	bindFlags(fs, &o)
	if err := fs.Parse([]string{"--name", "flagname"}); err != nil {
		t.Fatal(err)
	}
	if err := applyEnv(fs, &o, nil); err != nil {
		t.Fatal(err)
	}
	if o.hub != "ws://alias/agent/ws" || o.key != "gp_dev_local" || o.heartbeat != 7 || o.stateDir != "/var/lib/glimt-agent" || o.name != "flagname" {
		t.Errorf("options = %+v", o)
	}

	t.Setenv("GLIMT_HUB", "ws://primary/agent/ws")
	fs2 := flag.NewFlagSet("t", flag.ContinueOnError)
	var o2 options
	bindFlags(fs2, &o2)
	_ = fs2.Parse([]string{"--hub", "ws://flag/agent/ws", "--heartbeat", "3"})
	if err := applyEnv(fs2, &o2, nil); err != nil {
		t.Fatal(err)
	}
	if o2.hub != "ws://flag/agent/ws" || o2.heartbeat != 3 {
		t.Errorf("flags must win: %+v", o2)
	}

	t.Setenv("GLIMT_HEARTBEAT_SECONDS", "zero")
	fs3 := flag.NewFlagSet("t", flag.ContinueOnError)
	var o3 options
	bindFlags(fs3, &o3)
	_ = fs3.Parse(nil)
	if err := applyEnv(fs3, &o3, nil); err == nil {
		t.Error("bad heartbeat env must fail")
	}
}

func TestCheckRuns(t *testing.T) {
	t.Setenv("GLIMT_AGENT_DOCKER", "")
	var out, errb bytes.Buffer
	code := run([]string{"check", "--state-dir", t.TempDir(), "--proxy-url", "tcp://127.0.0.1:1"}, &out, &errb)
	if code != 0 {
		t.Fatalf("check: code=%d err=%q", code, errb.String())
	}
	for _, want := range []string{"hostname:", "journald:", "docker socket:", "docker proxy:", "needrestart:", "state dir:"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("check output lacks %q:\n%s", want, out.String())
		}
	}
}

func TestReadEnvFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "env")
	if err := os.WriteFile(path, []byte("# comment\nGLIMT_HUB=ws://h/agent/ws\nGLIMT_AGENT_DOCKER=\"proxy\"\nbroken\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := readEnvFile(path)
	if got["GLIMT_HUB"] != "ws://h/agent/ws" || got["GLIMT_AGENT_DOCKER"] != "proxy" || len(got) != 2 {
		t.Errorf("got %v", got)
	}
	if n := len(readEnvFile(filepath.Join(t.TempDir(), "missing"))); n != 0 {
		t.Errorf("missing file should give empty map, got %d", n)
	}
}

func TestUninstallRequiresRoot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root")
	}
	var out, errb bytes.Buffer
	if code := run([]string{"uninstall", "--dry-run"}, &out, &errb); code != 1 || !strings.Contains(errb.String(), "root") {
		t.Errorf("code=%d err=%q", code, errb.String())
	}
}

func TestHumanHelpers(t *testing.T) {
	if got := humanBytes(8589934592); got != "8.0 GiB" {
		t.Errorf("humanBytes = %q", got)
	}
	if got := humanBytes(512); got != "512 B" {
		t.Errorf("humanBytes = %q", got)
	}
	if got := humanDuration(3548000); got != "41d 1h" {
		t.Errorf("humanDuration = %q", got)
	}
	if got := humanDuration(125); got != "2m" {
		t.Errorf("humanDuration = %q", got)
	}
}

// The unit embedded in install.sh must be identical to install/glimt-agent.service,
// and the script must carry the exact read-only sentence.
func TestInstallScriptMatchesUnit(t *testing.T) {
	script, err := os.ReadFile(filepath.Join("..", "..", "install", "install.sh"))
	if err != nil {
		t.Skip("install.sh not found")
	}
	unit, err := os.ReadFile(filepath.Join("..", "..", "install", "glimt-agent.service"))
	if err != nil {
		t.Fatal(err)
	}
	s := string(script)
	start := strings.Index(s, "cat > \"$unit_tmp\" <<'UNIT'\n")
	if start < 0 {
		t.Fatal("unit heredoc not found in install.sh")
	}
	start += len("cat > \"$unit_tmp\" <<'UNIT'\n")
	end := strings.Index(s[start:], "\nUNIT\n")
	if end < 0 {
		t.Fatal("unit heredoc not terminated")
	}
	embedded := s[start:start+end] + "\n"
	if embedded != string(unit) {
		t.Errorf("install.sh unit differs from glimt-agent.service\n--- script ---\n%s\n--- file ---\n%s", embedded, unit)
	}
	const sentence = "Glimtpanel agent reads CPU, memory, disk, network, processes, containers and logs. It cannot change anything on this server."
	if !strings.Contains(s, sentence) {
		t.Error("install.sh lacks the read-only sentence")
	}
	if !strings.HasSuffix(strings.TrimSpace(s), "main \"$@\"") {
		t.Error("install.sh must end with main \"$@\"")
	}
}
