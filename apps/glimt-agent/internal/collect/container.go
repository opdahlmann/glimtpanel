package collect

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// ContainerOptions configure NewContainerSystem. Zero values mean defaults.
type ContainerOptions struct {
	ProcRoot   string // default "/proc"
	CgroupRoot string // default "/sys/fs/cgroup"
	EtcRoot    string // default "/etc"
	HostCores  int    // cores when cpu.max has no limit; default runtime.NumCPU()
	Logger     *slog.Logger
}

// ContainerCapabilities is what the profile found it can read (hello.capabilities).
type ContainerCapabilities struct {
	Cgroup  bool // cpu.stat and memory.current of the measured container
	ProcAll bool // the agent sees processes other than its own (shared pid namespace, or in the image)
	Netns   bool // /proc/net/dev is readable
}

// ContainerSystem is the System of the container profile (fase 12): cpu and
// memory from the container's cgroup when it is the right one, otherwise
// summed over the visible processes (approx); root and volumes from
// mountinfo; interfaces; processes; listening ports. No services,
// maintenance, logins, SSH counts or firewall.
type ContainerSystem struct {
	o     ContainerOptions
	log   *slog.Logger
	now   func() time.Time
	dir   string // cgroup directory, "" = none
	caps  ContainerCapabilities
	procs *procCollector
	disks *containerDisks
	nets  *netCollector
	pid1  int64 // starttime ticks of pid 1, for uptime

	mu     sync.Mutex
	prev   cgroupStats
	ok     bool
	lastAt time.Time
	last   protocol.Host
}

// NewContainerSystem probes the environment once (cgroup directory,
// process visibility) and primes the rate counters.
func NewContainerSystem(o ContainerOptions) *ContainerSystem {
	if o.ProcRoot == "" {
		o.ProcRoot = "/proc"
	}
	if o.CgroupRoot == "" {
		o.CgroupRoot = "/sys/fs/cgroup"
	}
	if o.EtcRoot == "" {
		o.EtcRoot = "/etc"
	}
	if o.HostCores <= 0 {
		o.HostCores = runtime.NumCPU()
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	s := &ContainerSystem{
		o:     o,
		log:   o.Logger,
		now:   time.Now,
		procs: newProcCollector(o.ProcRoot, o.EtcRoot, o.Logger),
		disks: newContainerDisks(o.ProcRoot, o.Logger),
		nets:  newNetCollector(o.ProcRoot, o.Logger),
	}
	s.procs.sums, s.procs.selfPID = true, os.Getpid()
	s.dir = resolveCgroupDir(o.ProcRoot, o.CgroupRoot)
	if s.dir != "" {
		if st, err := readCgroup(s.dir); err == nil {
			st.At = s.now()
			s.prev, s.ok, s.caps.Cgroup = st, true, true
		} else {
			s.log.Warn("cgroup not readable; cpu and memory will be summed over visible processes", "dir", s.dir, "err", err)
			s.dir = ""
		}
	}
	s.caps.ProcAll = s.seesOtherProcesses()
	if _, err := os.Stat(filepath.Join(o.ProcRoot, "net", "dev")); err == nil {
		s.caps.Netns = true
	}
	s.pid1 = pid1StartTicks(o.ProcRoot)
	// Prime the process rates (they need two samples).
	_, _, _ = s.procs.Collect(context.Background(), 1)
	return s
}

// Capabilities reports what the profile can read.
func (s *ContainerSystem) Capabilities() ContainerCapabilities { return s.caps }

// CgroupDir is the cgroup directory in use ("" = none), for `check`.
func (s *ContainerSystem) CgroupDir() string { return s.dir }

// Limits returns the container's allotment from cpu.max and memory.max (zero = none).
func (s *ContainerSystem) Limits() protocol.Limits {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.ok {
		return protocol.Limits{}
	}
	return protocol.Limits{CPUCores: s.prev.CPUCores, MemBytes: s.prev.MemMax}
}

// Cores is what hello reports: the allotted cores rounded up, else the host's.
func (s *ContainerSystem) Cores() int {
	if l := s.Limits(); l.CPUCores > 0 {
		return int(math.Ceil(l.CPUCores))
	}
	return s.o.HostCores
}

// RAMBytes is what hello reports: the memory limit, else the host's total.
func (s *ContainerSystem) RAMBytes() int64 {
	if l := s.Limits(); l.MemBytes > 0 {
		return l.MemBytes
	}
	if mem, err := readMeminfo(s.o.ProcRoot); err == nil {
		return mem.Total
	}
	return 0
}

func (s *ContainerSystem) seesOtherProcesses() bool {
	dir, err := os.Open(s.o.ProcRoot)
	if err != nil {
		return false
	}
	names, err := dir.Readdirnames(-1)
	dir.Close()
	if err != nil {
		return false
	}
	own := os.Getpid()
	for _, n := range names {
		if n == "" || n[0] < '0' || n[0] > '9' {
			continue
		}
		if pid, err := parsePID(n); err == nil && pid != own && pid != 1 {
			return true
		}
		if n == "1" && own != 1 {
			return true
		}
	}
	return false
}

func parsePID(s string) (int, error) {
	v, ok := parseUintBytes([]byte(s))
	if !ok {
		return 0, errors.New("not a pid")
	}
	return int(v), nil
}

// pid1StartTicks reads starttime of pid 1 (ticks since boot), 0 when unreadable.
func pid1StartTicks(procRoot string) int64 {
	data, err := os.ReadFile(filepath.Join(procRoot, "1", "stat"))
	if err != nil {
		return 0
	}
	var sm procSample
	if err := parseProcStat(data, &sm); err != nil {
		return 0
	}
	return int64(sm.start)
}

// Host implements System: cpu and memory of the container, its mounts and interfaces.
func (s *ContainerSystem) Host(ctx context.Context) (protocol.Host, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if !s.lastAt.IsZero() && now.Sub(s.lastAt) < minSampleInterval {
		return s.last, nil
	}
	var out protocol.Host
	var errs []error
	hostCores := float64(s.o.HostCores)

	if s.dir != "" {
		st, err := readCgroup(s.dir)
		if err != nil {
			errs = append(errs, err)
		} else {
			st.At = now
			cores := st.CPUCores
			if cores <= 0 {
				cores = hostCores
			}
			if s.ok && st.At.After(s.prev.At) && st.UsageUsec >= s.prev.UsageUsec {
				dt := st.At.Sub(s.prev.At).Microseconds()
				if dt > 0 {
					out.CPU.Total = round1(math.Min(100, float64(st.UsageUsec-s.prev.UsageUsec)/float64(dt)/cores*100))
					out.CPU.User = out.CPU.Total
				}
			}
			s.prev, s.ok = st, true
			used := st.MemCurrent - st.InactiveFile
			if used < 0 {
				used = 0
			}
			total := st.MemMax
			if total <= 0 {
				if mem, err := readMeminfo(s.o.ProcRoot); err == nil {
					total = mem.Total
				}
			}
			out.Mem = protocol.Mem{Total: total, Used: used, Cached: st.InactiveFile}
			if total > used {
				out.Mem.Free = total - used
			}
			out.Limits = &protocol.Limits{CPUCores: st.CPUCores, MemBytes: st.MemMax}
		}
	} else {
		// No trustworthy cgroup: sum what /proc shows (procCollector.Sums).
		// CPU is per-process % of one core, so the total is against the
		// host's cores.
		_, _, err := s.procs.Collect(ctx, 1)
		if err != nil {
			errs = append(errs, err)
		}
		cpu, rss := s.procs.Sums()
		out.CPU.Total = round1(math.Min(100, cpu/hostCores))
		out.CPU.User = out.CPU.Total
		total := int64(0)
		if mem, err := readMeminfo(s.o.ProcRoot); err == nil {
			total = mem.Total
		}
		out.Mem = protocol.Mem{Total: total, Used: rss}
		if total > rss {
			out.Mem.Free = total - rss
		}
		out.Approx = true
	}

	out.UptimeSec = s.uptime(now)
	mounts, err := s.disks.Mounts(ctx)
	if err != nil {
		errs = append(errs, err)
	}
	out.Mounts = mounts
	ifaces, err := s.nets.Ifaces(ctx)
	if err != nil {
		errs = append(errs, err)
	}
	out.Ifaces = ifaces
	s.last, s.lastAt = out, now
	return out, errors.Join(errs...)
}

// uptime is the age of pid 1 (the container's main process), else /proc/uptime.
func (s *ContainerSystem) uptime(now time.Time) int64 {
	if s.pid1 > 0 {
		if st, err := readStat(s.o.ProcRoot); err == nil && st.BootTime > 0 {
			if up := now.UnixMilli() - startedAtMs(st.BootTime, uint64(s.pid1)); up > 0 {
				return up / 1000
			}
		}
	}
	up, _ := readUptime(s.o.ProcRoot)
	return up
}

// Processes implements System (the shared pid namespace shows the app's processes).
func (s *ContainerSystem) Processes(ctx context.Context, topN int) ([]protocol.Process, protocol.ProcessTotals, error) {
	if topN <= 0 {
		topN = 40
	}
	return s.procs.Collect(ctx, topN)
}

// Services implements System: none in a container.
func (s *ContainerSystem) Services(context.Context) (*protocol.Services, error) { return nil, nil }

// Maintenance implements System: none in a container.
func (s *ContainerSystem) Maintenance(context.Context) (*protocol.Maintenance, error) {
	return nil, nil
}

// Security implements System: listening ports only.
func (s *ContainerSystem) Security(ctx context.Context) (*protocol.Security, error) {
	return &protocol.Security{ListeningPorts: listeningPorts(s.o.ProcRoot, s.log)}, ctx.Err()
}

// --- mounts -------------------------------------------------------------

// pseudoFS are the file systems a container always has mounted that never
// hold user data. Everything else (overlay root, volumes, bind mounts of
// directories) is shown.
var pseudoFS = map[string]bool{
	"proc": true, "sysfs": true, "cgroup": true, "cgroup2": true, "tmpfs": true, "devtmpfs": true, "devpts": true,
	"mqueue": true, "securityfs": true, "debugfs": true, "tracefs": true, "bpf": true, "pstore": true, "configfs": true,
	"fusectl": true, "hugetlbfs": true, "nsfs": true, "binfmt_misc": true, "autofs": true, "rpc_pipefs": true,
}

var containerSkippedPrefixes = []string{"/proc", "/sys", "/dev"}

// containerMounts keeps the root and the volumes: not pseudo file systems,
// not under /proc, /sys or /dev. Bind mounts of single files (Docker's
// /etc/hosts, resolv.conf, hostname) are dropped by statAll (errNotDir).
func containerMounts(all []mountInfo) []mountInfo {
	var out []mountInfo
	seen := map[string]bool{}
	for _, m := range all {
		if pseudoFS[m.FSType] || seen[m.Path] {
			continue
		}
		skip := false
		for _, p := range containerSkippedPrefixes {
			if m.Path == p || (len(m.Path) > len(p) && m.Path[:len(p)+1] == p+"/") {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		seen[m.Path] = true
		out = append(out, m)
	}
	return out
}

// containerDisks is the disk collector of the container profile: the same
// statfs and diskstats machinery, another mount filter, and the root shown
// as "/" even though it is an overlay.
type containerDisks struct {
	inner *diskCollector
}

func newContainerDisks(procRoot string, log *slog.Logger) *containerDisks {
	return &containerDisks{inner: newDiskCollector(procRoot, "/sys", log)}
}

func (d *containerDisks) Mounts(ctx context.Context) ([]protocol.Mount, error) {
	f, err := os.Open(filepath.Join(d.inner.procRoot, "self/mountinfo"))
	if err != nil {
		return nil, err
	}
	all, err := parseMountinfo(f)
	f.Close()
	if err != nil {
		return nil, err
	}
	mounts := containerMounts(all)
	rates := d.inner.rates()
	out := make([]protocol.Mount, 0, len(mounts))
	for r := range d.inner.statAll(ctx, mounts) {
		m := mounts[r.i]
		if r.err != nil {
			continue
		}
		st := r.st
		if st.Blocks == 0 {
			continue
		}
		pm := protocol.Mount{
			Path:        m.Path,
			FS:          m.FSType,
			Total:       int64(st.Blocks * st.Bsize),
			Used:        int64((st.Blocks - min(st.Bfree, st.Blocks)) * st.Bsize),
			InodesTotal: int64(st.Files),
			InodesUsed:  int64(st.Files - min(st.Ffree, st.Files)),
		}
		if m.FSType != "overlay" {
			pm.Device = m.Source
		}
		if rate, ok := rates[m.Dev]; ok {
			pm.ReadBps, pm.WriteBps = rate.read, rate.write
		}
		out = append(out, pm)
	}
	// Root first, then the volumes by path.
	sort.SliceStable(out, func(i, j int) bool {
		if (out[i].Path == "/") != (out[j].Path == "/") {
			return out[i].Path == "/"
		}
		return out[i].Path < out[j].Path
	})
	return out, ctx.Err()
}
