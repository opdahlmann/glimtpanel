package sysinfo

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

func writeFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func noEnv(string) string { return "" }

func TestDetectKind(t *testing.T) {
	root := t.TempDir()
	proc := filepath.Join(root, "proc")
	writeFile(t, filepath.Join(proc, "1", "cgroup"), "0::/init.scope\n")
	if kind, _ := DetectKind(KindAuto, root, proc, noEnv); kind != protocol.KindServer {
		t.Errorf("bare root: %s", kind)
	}
	if kind, r := DetectKind(protocol.KindContainer, root, proc, noEnv); kind != protocol.KindContainer || r[0] != "set explicitly" {
		t.Errorf("explicit: %s %v", kind, r)
	}

	writeFile(t, filepath.Join(root, ".dockerenv"), "")
	if kind, r := DetectKind(KindAuto, root, proc, noEnv); kind != protocol.KindContainer || r[0] != "/.dockerenv exists" {
		t.Errorf("dockerenv: %s %v", kind, r)
	}
	if kind, _ := DetectKind(protocol.KindServer, root, proc, noEnv); kind != protocol.KindServer {
		t.Error("explicit server should win over /.dockerenv")
	}

	// Kubernetes: no /.dockerenv, but pid 1 sits under kubepods.
	root2 := t.TempDir()
	proc2 := filepath.Join(root2, "proc")
	writeFile(t, filepath.Join(proc2, "1", "cgroup"), "0::/kubepods/burstable/pod1/cri-containerd-8e49456bd7f9bc8a5e6ac6450edc0e2f4e94445c980aa2e27e1370a62d63f5e7.scope\n")
	if kind, r := DetectKind(KindAuto, root2, proc2, noEnv); kind != protocol.KindContainer || r[0] != "/proc/1/cgroup mentions kubepods" {
		t.Errorf("kubepods: %s %v", kind, r)
	}

	// Cloud Run (gVisor): nothing on disk, but K_SERVICE is set.
	root3 := t.TempDir()
	env := func(n string) string {
		if n == "K_SERVICE" {
			return "api"
		}
		return ""
	}
	if kind, r := DetectKind(KindAuto, root3, filepath.Join(root3, "proc"), env); kind != protocol.KindContainer || r[0] != "K_SERVICE is set" {
		t.Errorf("cloud run: %s %v", kind, r)
	}
}

func TestContainerID(t *testing.T) {
	root := t.TempDir()
	proc := filepath.Join(root, "proc")
	// Sidecar with a private cgroup namespace: own cgroup is "/", pid 1 shows the app container's id.
	writeFile(t, filepath.Join(proc, "self", "cgroup"), "0::/\n")
	writeFile(t, filepath.Join(proc, "1", "cgroup"), "0::/../8e49456bd7f9bc8a5e6ac6450edc0e2f4e94445c980aa2e27e1370a62d63f5e7\n")
	if got := ContainerID(proc, "hostname"); got != "8e49456bd7f9" {
		t.Errorf("sidecar: %q", got)
	}
	// Same container (binary in the image), host cgroup namespace: docker/<id>.
	writeFile(t, filepath.Join(proc, "1", "cgroup"), "0::/docker/37efb0731ce637f53c25e66f36d5e834edb3c47ca951a48bf2f2b59d175e763a\n")
	if got := ContainerID(proc, "hostname"); got != "37efb0731ce6" {
		t.Errorf("host cgroupns: %q", got)
	}
	// systemd driver.
	writeFile(t, filepath.Join(proc, "1", "cgroup"), "0::/system.slice/docker-abcdef123456abcdef123456abcdef123456abcdef123456abcdef123456abcd.scope\n")
	if got := ContainerID(proc, "hostname"); got != "abcdef123456" {
		t.Errorf("systemd: %q", got)
	}
	// Nothing readable (gVisor): the hostname, cut to 12.
	writeFile(t, filepath.Join(proc, "1", "cgroup"), "0::/\n")
	if got := ContainerID(proc, "acme-backend-7d9f8c6b5-xk2lp"); got != "acme-backend" {
		t.Errorf("hostname: %q", got)
	}
}
