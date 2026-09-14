package sysinfo

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// Kind values (protocol.KindServer / KindContainer) and the auto setting.
const KindAuto = "auto"

// containerEnvHints are environment variables that only exist on container
// platforms: Kubernetes, Cloud Run, ECS, Railway, Render, and our own
// GLIMT_TOKEN (a long-lived node token is only issued for container nodes).
var containerEnvHints = []string{
	"KUBERNETES_SERVICE_HOST", "K_SERVICE", "ECS_CONTAINER_METADATA_URI", "ECS_CONTAINER_METADATA_URI_V4",
	"RAILWAY_ENVIRONMENT", "RENDER", "GLIMT_TOKEN",
}

// cgroupHints in /proc/1/cgroup mean pid 1 is a container's process.
var cgroupHints = []string{"docker", "kubepods", "containerd", "libpod", "ecs"}

// DetectKind decides between server and container. With KindAuto the
// answer is container when /.dockerenv or /run/.containerenv exists, when
// /proc/1/cgroup mentions a container runtime, or when a platform variable
// is set; otherwise server. The reasons say why, for `check`.
func DetectKind(kind, root, procRoot string, env func(string) string) (string, []string) {
	switch kind {
	case protocol.KindServer, protocol.KindContainer:
		return kind, []string{"set explicitly"}
	}
	var reasons []string
	for _, marker := range []string{".dockerenv", "run/.containerenv"} {
		if _, err := os.Stat(filepath.Join(root, marker)); err == nil {
			reasons = append(reasons, "/"+marker+" exists")
		}
	}
	if data, err := os.ReadFile(filepath.Join(procRoot, "1", "cgroup")); err == nil {
		text := string(data)
		for _, h := range cgroupHints {
			if strings.Contains(text, h) {
				reasons = append(reasons, "/proc/1/cgroup mentions "+h)
				break
			}
		}
	}
	if env != nil {
		for _, name := range containerEnvHints {
			if strings.TrimSpace(env(name)) != "" {
				reasons = append(reasons, name+" is set")
				break
			}
		}
	}
	if len(reasons) == 0 {
		return protocol.KindServer, []string{"no container markers"}
	}
	return protocol.KindContainer, reasons
}

var hexID = regexp.MustCompile(`[0-9a-f]{12,64}`)

// ContainerID returns the first 12 characters of the container id: the hex
// id in /proc/1/cgroup (a sidecar sharing the pid namespace sees the app
// container's id there as "0::/../<id>"), else in /proc/self/cgroup, else
// the hostname (Docker's default hostname is the short id).
func ContainerID(procRoot, hostname string) string {
	for _, pid := range []string{"1", "self"} {
		data, err := os.ReadFile(filepath.Join(procRoot, pid, "cgroup"))
		if err != nil {
			continue
		}
		if id := idFromCgroup(string(data)); id != "" {
			return id
		}
	}
	if len(hostname) > 12 {
		return hostname[:12]
	}
	return hostname
}

// idFromCgroup finds a container id in the cgroup file's paths.
func idFromCgroup(text string) string {
	for _, line := range strings.Split(text, "\n") {
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			continue
		}
		// The last path segment is the container's own cgroup ("docker-<id>.scope", "<id>", "cri-containerd-<id>.scope").
		segments := strings.Split(parts[2], "/")
		for i := len(segments) - 1; i >= 0; i-- {
			if m := hexID.FindString(segments[i]); m != "" {
				return m[:12]
			}
		}
	}
	return ""
}
