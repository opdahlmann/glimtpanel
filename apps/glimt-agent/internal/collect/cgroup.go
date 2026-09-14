package collect

import (
	"bufio"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// cgroupStats is one reading of a cgroup v2 directory.
type cgroupStats struct {
	UsageUsec    uint64 // cpu.stat usage_usec
	MemCurrent   int64  // memory.current
	InactiveFile int64  // memory.stat inactive_file (page cache the kernel can drop)
	MemMax       int64  // memory.max, 0 = max (no limit)
	CPUCores     float64
	At           time.Time
}

// readCgroup reads the files the container profile needs from dir. An
// unreadable cpu.stat or memory.current is an error (no cgroup here, as on
// gVisor); the limits are optional.
func readCgroup(dir string) (cgroupStats, error) {
	var st cgroupStats
	usage, err := cgroupKeyValue(filepath.Join(dir, "cpu.stat"), "usage_usec")
	if err != nil {
		return st, err
	}
	st.UsageUsec = uint64(usage)
	cur, err := cgroupInt(filepath.Join(dir, "memory.current"))
	if err != nil {
		return st, err
	}
	st.MemCurrent = cur
	if v, err := cgroupKeyValue(filepath.Join(dir, "memory.stat"), "inactive_file"); err == nil {
		st.InactiveFile = v
	}
	if v, err := cgroupInt(filepath.Join(dir, "memory.max")); err == nil {
		st.MemMax = v
	}
	st.CPUCores = cgroupCPUMax(filepath.Join(dir, "cpu.max"))
	return st, nil
}

// cgroupInt reads a single number; "max" reads as 0.
func cgroupInt(path string) (int64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	text := strings.TrimSpace(string(data))
	if text == "max" {
		return 0, nil
	}
	return strconv.ParseInt(text, 10, 64)
}

// cgroupKeyValue reads "key value" lines (cpu.stat, memory.stat).
func cgroupKeyValue(path, key string) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), " ")
		if ok && k == key {
			return strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		}
	}
	if err := sc.Err(); err != nil {
		return 0, err
	}
	return 0, errors.New(filepath.Base(path) + ": no " + key)
}

// cgroupCPUMax parses cpu.max ("quota period" or "max period") into cores; 0 = no limit.
func cgroupCPUMax(path string) float64 {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	f := strings.Fields(string(data))
	if len(f) < 2 || f[0] == "max" {
		return 0
	}
	quota, err1 := strconv.ParseFloat(f[0], 64)
	period, err2 := strconv.ParseFloat(f[1], 64)
	if err1 != nil || err2 != nil || period <= 0 || quota <= 0 {
		return 0
	}
	return quota / period
}

// cgroupPath returns the v2 path of a process from its /proc/<pid>/cgroup ("0::/path").
func cgroupPath(procRoot, pid string) string {
	data, err := os.ReadFile(filepath.Join(procRoot, pid, "cgroup"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "0::") {
			return strings.TrimPrefix(line, "0::")
		}
	}
	return ""
}

// resolveCgroupDir finds the cgroup directory that describes the container
// the agent is measuring, or "" when there is none it can trust:
//
//   - binary in the image: pid 1 and the agent share a cgroup → the mounted
//     cgroup root (private namespace: /sys/fs/cgroup; host namespace:
//     /sys/fs/cgroup/<path>);
//   - sidecar with a host cgroup namespace: pid 1's path exists under
//     /sys/fs/cgroup → that directory;
//   - sidecar with a private cgroup namespace: pid 1 shows "/../<id>", which
//     is not reachable, and the agent's own cgroup is the sidecar's, not the
//     app's → "" (the profile then sums the visible processes).
func resolveCgroupDir(procRoot, cgroupRoot string) string {
	self := cgroupPath(procRoot, "self")
	pid1 := cgroupPath(procRoot, "1")
	if self == "" {
		return ""
	}
	if pid1 == "" || pid1 == self {
		if dir := filepath.Join(cgroupRoot, self); dirHasFile(dir, "cpu.stat") {
			return dir
		}
		return ""
	}
	if strings.Contains(pid1, "..") {
		return ""
	}
	if dir := filepath.Join(cgroupRoot, pid1); dirHasFile(dir, "cpu.stat") {
		return dir
	}
	return ""
}

func dirHasFile(dir, name string) bool {
	_, err := os.Stat(filepath.Join(dir, name))
	return err == nil
}
