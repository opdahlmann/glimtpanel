package collect

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// copyDir copies a flat fixture directory into a temp dir the test may edit.
func copyDir(t *testing.T, src string) string {
	t.Helper()
	dst := t.TempDir()
	entries, err := os.ReadDir(src)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		data, err := os.ReadFile(filepath.Join(src, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, e.Name()), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dst
}

// fixtureProc builds a /proc with the given cgroup lines and the gVisor
// fixture's stat, meminfo and uptime, so Host() has a memory total and a
// boot time to work with.
func fixtureProc(t *testing.T, selfCgroup, pid1Cgroup string) string {
	t.Helper()
	dir := t.TempDir()
	for _, sub := range []string{"self", "1"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(name, text string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("self/cgroup", selfCgroup)
	write("1/cgroup", pid1Cgroup)
	for _, name := range []string{"stat", "meminfo", "uptime", "1/stat"} {
		data, err := os.ReadFile(filepath.Join("testdata/gvisor/proc", name))
		if err != nil {
			t.Fatal(err)
		}
		write(name, string(data))
	}
	return dir
}

func TestReadCgroup(t *testing.T) {
	st, err := readCgroup("testdata/cgroup/app")
	if err != nil {
		t.Fatal(err)
	}
	if st.UsageUsec != 1500000 || st.MemCurrent != 100<<20 || st.InactiveFile != 30<<20 || st.MemMax != 256<<20 || st.CPUCores != 1.5 {
		t.Errorf("app: %+v", st)
	}
	st, err = readCgroup("testdata/cgroup/free")
	if err != nil {
		t.Fatal(err)
	}
	if st.MemMax != 0 || st.CPUCores != 0 {
		t.Errorf("free: limits should be 0, got %+v", st)
	}
	if _, err := readCgroup(t.TempDir()); err == nil {
		t.Error("empty dir must fail")
	}
}

func TestResolveCgroupDir(t *testing.T) {
	const id = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f"
	cases := []struct {
		name, proc, root, want string
	}{
		{"binary in the image", "testdata/proc-cg-image", "testdata/cgroup/app", "testdata/cgroup/app"},
		{"sidecar, host cgroupns", "testdata/proc-cg-sidecar-host", "testdata/cgroup-host", "testdata/cgroup-host/docker/" + id},
		{"sidecar, private cgroupns", "testdata/proc-cg-sidecar-private", "testdata/cgroup/app", ""},
		{"gVisor: no cgroup files", "testdata/gvisor/proc", t.TempDir(), ""},
		{"no /proc", t.TempDir(), "testdata/cgroup/app", ""},
	}
	for _, c := range cases {
		if got := resolveCgroupDir(c.proc, c.root); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestContainerHostFromCgroup(t *testing.T) {
	cg := copyDir(t, "testdata/cgroup/app")
	proc := fixtureProc(t, "0::/\n", "0::/\n")
	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	s := NewContainerSystem(ContainerOptions{ProcRoot: proc, CgroupRoot: cg, EtcRoot: "testdata/etc", HostCores: 8})
	// Prime again with the injectable clock (the constructor used time.Now).
	s.now = func() time.Time { return now }
	s.prev.At = now
	if !s.Capabilities().Cgroup || s.CgroupDir() != cg {
		t.Fatalf("cgroup not detected: %+v dir=%q", s.Capabilities(), s.CgroupDir())
	}
	if l := s.Limits(); l.CPUCores != 1.5 || l.MemBytes != 256<<20 {
		t.Errorf("limits: %+v", l)
	}
	if s.Cores() != 2 || s.RAMBytes() != 256<<20 {
		t.Errorf("hello values: cores=%d ram=%d", s.Cores(), s.RAMBytes())
	}

	// 0.75 s of CPU over 1 s with 1.5 cores allotted = 50 %.
	if err := os.WriteFile(filepath.Join(cg, "cpu.stat"), []byte("usage_usec 2250000\nuser_usec 0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Second)
	host, _ := s.Host(context.Background())
	if host.CPU.Total != 50 {
		t.Errorf("cpu = %v want 50", host.CPU.Total)
	}
	if host.Approx || host.Mem.Total != 256<<20 || host.Mem.Used != 70<<20 || host.Mem.Cached != 30<<20 {
		t.Errorf("mem: approx=%v %+v", host.Approx, host.Mem)
	}
	if host.Limits == nil || host.Limits.CPUCores != 1.5 || host.Limits.MemBytes != 256<<20 {
		t.Errorf("limits in host: %+v", host.Limits)
	}
	if host.UptimeSec <= 0 {
		t.Errorf("uptime from pid 1: %d", host.UptimeSec)
	}
	// Within the sample interval the last reading is returned as is.
	if again, _ := s.Host(context.Background()); again.CPU.Total != 50 {
		t.Errorf("cached reading changed: %v", again.CPU.Total)
	}
}

func TestContainerHostWithoutLimits(t *testing.T) {
	cg := copyDir(t, "testdata/cgroup/free")
	proc := fixtureProc(t, "0::/\n", "0::/\n")
	s := NewContainerSystem(ContainerOptions{ProcRoot: proc, CgroupRoot: cg, EtcRoot: "testdata/etc", HostCores: 4})
	if l := s.Limits(); l.CPUCores != 0 || l.MemBytes != 0 {
		t.Errorf("limits: %+v", l)
	}
	// No limit: the host's cores and the host's memory total from meminfo.
	if s.Cores() != 4 || s.RAMBytes() != 1<<30 {
		t.Errorf("hello values: cores=%d ram=%d", s.Cores(), s.RAMBytes())
	}
	now := time.Now().Add(time.Second)
	s.now = func() time.Time { return now }
	host, _ := s.Host(context.Background())
	if host.Mem.Total != 1<<30 || host.Approx {
		t.Errorf("host: approx=%v %+v", host.Approx, host.Mem)
	}
}

// The sidecar with a private cgroup namespace and gVisor both end up
// without a cgroup: cpu and memory are then summed over the visible
// processes and marked approx.
func TestContainerHostFallbackSums(t *testing.T) {
	s := NewContainerSystem(ContainerOptions{ProcRoot: "testdata/gvisor/proc", CgroupRoot: t.TempDir(), EtcRoot: "testdata/etc", HostCores: 2})
	caps := s.Capabilities()
	if caps.Cgroup || !caps.ProcAll || !caps.Netns {
		t.Errorf("capabilities: %+v", caps)
	}
	if s.Cores() != 2 || s.RAMBytes() != 1<<30 {
		t.Errorf("hello values: cores=%d ram=%d", s.Cores(), s.RAMBytes())
	}
	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	s.procs.now = s.now
	host, err := s.Host(context.Background())
	if err != nil {
		t.Logf("partial errors are fine: %v", err)
	}
	if !host.Approx {
		t.Error("fallback must be marked approx")
	}
	// node's status: RssAnon 60 MiB + RssShmem 4 MiB, RssFile 16 MiB counted once.
	if host.Mem.Total != 1<<30 || host.Mem.Used != 80<<20 {
		t.Errorf("mem sums: %+v", host.Mem)
	}
	if host.CPU.Total < 0 || host.CPU.Total > 100 {
		t.Errorf("cpu out of range: %v", host.CPU.Total)
	}
	if host.UptimeSec <= 0 {
		t.Errorf("uptime: %d", host.UptimeSec)
	}
	// The overlay root is shown as "/" without a device; /data is not
	// mounted on the test machine and is skipped.
	if len(host.Mounts) == 0 || host.Mounts[0].Path != "/" || host.Mounts[0].Device != "" {
		t.Errorf("mounts: %+v", host.Mounts)
	}
	if len(host.Ifaces) != 1 || host.Ifaces[0].Name != "eth0" {
		t.Errorf("ifaces: %+v", host.Ifaces)
	}
	procs, totals, err := s.Processes(context.Background(), 5)
	if err != nil || len(procs) != 1 || procs[0].Name != "node" || totals.Total != 1 {
		t.Errorf("processes: %v %+v %+v", err, procs, totals)
	}
	sec, err := s.Security(context.Background())
	if err != nil || len(sec.ListeningPorts) != 1 || sec.ListeningPorts[0].Port != 3000 {
		t.Errorf("security: %v %+v", err, sec)
	}
	if svc, err := s.Services(context.Background()); svc != nil || err != nil {
		t.Errorf("services must be nil: %+v %v", svc, err)
	}
	if m, err := s.Maintenance(context.Background()); m != nil || err != nil {
		t.Errorf("maintenance must be nil: %+v %v", m, err)
	}
}

func TestContainerMountsFilter(t *testing.T) {
	all := []mountInfo{
		{Path: "/", FSType: "overlay", Source: "overlay", Dev: "0:20"},
		{Path: "/proc", FSType: "proc"},
		{Path: "/proc/sys", FSType: "proc"},
		{Path: "/dev/shm", FSType: "tmpfs"},
		{Path: "/sys/fs/cgroup", FSType: "cgroup2"},
		{Path: "/data", FSType: "ext4", Source: "/dev/sdb1"},
		{Path: "/data", FSType: "ext4", Source: "/dev/sdb1"},
		{Path: "/etc/hosts", FSType: "ext4", Source: "/dev/sda1"},
	}
	got := containerMounts(all)
	if len(got) != 3 || got[0].Path != "/" || got[1].Path != "/data" || got[2].Path != "/etc/hosts" {
		t.Errorf("got %+v", got)
	}
}

func TestParseStatusRSS(t *testing.T) {
	anon, file, ok := parseStatusRSS([]byte("Name:\tx\nVmRSS:\t 100 kB\nRssAnon:\t 60 kB\nRssFile:\t 30 kB\nRssShmem:\t 10 kB\n"))
	if !ok || anon != 70*1024 || file != 30*1024 {
		t.Errorf("got anon=%d file=%d ok=%v", anon, file, ok)
	}
	if _, _, ok := parseStatusRSS([]byte("Name:\tx\nVmRSS:\t 100 kB\n")); ok {
		t.Error("old kernels without RssAnon must report !ok")
	}
}

// The agent's own process is not part of the app; a process without a
// readable status falls back to the rss field of stat.
func TestEstimateSumsSkipsSelfAndFallsBack(t *testing.T) {
	c := newProcCollector("testdata/gvisor/proc", "testdata/etc", nil)
	c.sums, c.selfPID = true, 1
	if _, _, err := c.Collect(context.Background(), 5); err != nil {
		t.Fatal(err)
	}
	if cpu, mem := c.Sums(); cpu != 0 || mem != 0 {
		t.Errorf("self excluded: cpu=%v mem=%d", cpu, mem)
	}
	c = newProcCollector("testdata/proc-a", "testdata/etc", nil)
	c.sums = true
	if _, _, err := c.Collect(context.Background(), 5); err != nil {
		t.Fatal(err)
	}
	if _, mem := c.Sums(); mem <= 0 {
		t.Errorf("fixture without RssAnon should still give a sum: %d", mem)
	}
}
