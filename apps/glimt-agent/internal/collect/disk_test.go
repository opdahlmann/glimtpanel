package collect

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseMountinfo(t *testing.T) {
	all, err := parseMountinfo(strings.NewReader(fixture(t, "proc-a/self/mountinfo")))
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 37 {
		t.Errorf("parsed %d mounts, want 37", len(all))
	}
	var root, backup, nas mountInfo
	for _, m := range all {
		switch m.Path {
		case "/":
			root = m
		case "/mnt/my backup":
			backup = m
		case "/mnt/nas":
			nas = m
		}
	}
	if root.Dev != "259:2" || root.FSType != "ext4" || root.Source != "/dev/nvme0n1p2" || root.Root != "/" {
		t.Errorf("root = %+v", root)
	}
	if backup.Dev != "8:33" || backup.FSType != "ext4" {
		t.Errorf("escaped path not decoded: %+v", backup)
	}
	if nas.FSType != "nfs4" || nas.Source != "192.168.1.10:/volume1/share" {
		t.Errorf("nas = %+v", nas)
	}
	if _, err := parseMountinfo(strings.NewReader("")); err == nil {
		t.Error("empty mountinfo must fail")
	}
}

func TestUnescapeMount(t *testing.T) {
	cases := map[string]string{
		`/mnt/my\040backup`: "/mnt/my backup",
		`/plain`:            "/plain",
		`/tab\011x`:         "/tab\tx",
		`/back\134slash`:    `/back\slash`,
		`/trailing\04`:      `/trailing\04`,
	}
	for in, want := range cases {
		if got := unescapeMount(in); got != want {
			t.Errorf("unescapeMount(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRealMounts(t *testing.T) {
	all, _ := parseMountinfo(strings.NewReader(fixture(t, "proc-a/self/mountinfo")))
	got := realMounts(all)
	var paths []string
	for _, m := range got {
		paths = append(paths, m.Path)
	}
	want := "/ /boot/efi /home /mnt/my backup /mnt/nas /srv/projects /mnt/sshfs /var/www"
	if strings.Join(paths, " ") != want {
		t.Errorf("real mounts = %q\nwant %q", strings.Join(paths, " "), want)
	}
	for _, p := range []string{"/var/lib/machines-root", "/mnt/rootbind", "/snap/core22/1564", "/run/user/1000", "/var/lib/docker/overlay2/3f2a1b/merged", "/var/lib/docker/volumes/pgdata/_data", "/mnt/gcsfuse", "/sys/fs/cgroup", "/dev/shm"} {
		if contains(paths, p) {
			t.Errorf("%s must be dropped", p)
		}
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func TestParseDiskstats(t *testing.T) {
	st, err := parseDiskstats(strings.NewReader(fixture(t, "proc-a/diskstats")))
	if err != nil {
		t.Fatal(err)
	}
	if len(st) != 11 {
		t.Errorf("%d devices, want 11", len(st))
	}
	nv := st["259:2"]
	if nv.Name != "nvme0n1p2" || nv.ReadBytes != 5990000*512 || nv.WriteBytes != 3999800*512 {
		t.Errorf("nvme0n1p2 = %+v", nv)
	}
	if _, err := parseDiskstats(strings.NewReader("   8 0 sda short\n")); err != nil {
		t.Errorf("short lines are skipped, not an error: %v", err)
	}
}

func TestBytesPerSec(t *testing.T) {
	if v := bytesPerSec(100, 1100, 2); v != 500 {
		t.Errorf("got %v", v)
	}
	if v := bytesPerSec(1100, 100, 2); v != 0 {
		t.Errorf("backwards counter must give 0, got %v", v)
	}
	if v := bytesPerSec(0, 100, 0); v != 0 {
		t.Errorf("zero interval must give 0, got %v", v)
	}
}

func TestDiskCollectorMounts(t *testing.T) {
	proc := t.TempDir()
	stageTree(t, proc, "proc-a")
	clk := &clock{t: t0}
	d := newDiskCollector(proc, sysTree(t), quietLogger())
	d.statfs, d.now = fakeStatfs(statfsTable), clk.now

	first, err := d.Mounts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 8 {
		t.Fatalf("%d mounts, want 8: %+v", len(first), first)
	}
	var order []string
	for _, m := range first {
		order = append(order, m.Path)
		if m.ReadBps != 0 || m.WriteBps != 0 {
			t.Errorf("first sample must have zero rates: %+v", m)
		}
	}
	want := "/home /srv/projects /mnt/sshfs / /var/www /mnt/nas /mnt/my backup /boot/efi"
	if strings.Join(order, " ") != want {
		t.Errorf("order = %q\nwant %q", strings.Join(order, " "), want)
	}
	root := first[3]
	if root.Path != "/" || root.FS != "ext4" || root.Device != "/dev/nvme0n1p2" {
		t.Errorf("root = %+v", root)
	}
	if root.Total != 100000000*4096 || root.Used != 70000000*4096 || root.InodesTotal != 25000000 || root.InodesUsed != 1000000 {
		t.Errorf("root sizes = %+v", root)
	}
	if nas := first[5]; nas.Total != 3000000*1048576 || nas.Used != 2000000*1048576 {
		t.Errorf("nas sizes = %+v", nas)
	}

	stageTree(t, proc, "proc-b")
	clk.advance(time.Second)
	second, err := d.Mounts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	byPath := map[string]int{}
	for i, m := range second {
		byPath[m.Path] = i
	}
	check := func(path string, read, write float64) {
		t.Helper()
		m := second[byPath[path]]
		if m.ReadBps != read || m.WriteBps != write {
			t.Errorf("%s rates = %v/%v, want %v/%v", path, m.ReadBps, m.WriteBps, read, write)
		}
	}
	check("/", 2048*512, 1024*512)
	check("/var/www", 2048*512, 1024*512)
	check("/home", 0, 4096*512)
	check("/srv/projects", 0, 4096*512)
	check("/mnt/my backup", 200*512, 0) // partition row missing → parent disk sdc
	check("/boot/efi", 0, 0)
	check("/mnt/nas", 0, 0)
}

func TestDiskCollectorWithoutSys(t *testing.T) {
	proc := t.TempDir()
	stageTree(t, proc, "proc-a")
	clk := &clock{t: t0}
	d := newDiskCollector(proc, filepath.Join(t.TempDir(), "nosys"), quietLogger())
	d.statfs, d.now = fakeStatfs(statfsTable), clk.now
	if _, err := d.Mounts(context.Background()); err != nil {
		t.Fatal(err)
	}
	stageTree(t, proc, "proc-b")
	clk.advance(time.Second)
	mounts, _ := d.Mounts(context.Background())
	for _, m := range mounts {
		if m.Path == "/mnt/my backup" && m.ReadBps != 0 {
			t.Errorf("without /sys the parent lookup must give 0, got %v", m.ReadBps)
		}
	}
}

func TestDiskCollectorSkipsFailedStatfs(t *testing.T) {
	proc := t.TempDir()
	stageTree(t, proc, "proc-a")
	d := newDiskCollector(proc, "", quietLogger())
	d.statfs = fakeStatfs(map[string]statfsResult{"/": statfsTable["/"]})
	mounts, err := d.Mounts(context.Background())
	if err != nil || len(mounts) != 1 || mounts[0].Path != "/" {
		t.Errorf("mounts = %+v err=%v", mounts, err)
	}
	if _, err := newDiskCollector(t.TempDir(), "", quietLogger()).Mounts(context.Background()); err == nil {
		t.Error("missing mountinfo must fail")
	}
}

func TestDiskCollectorSkipsFileMounts(t *testing.T) {
	proc := t.TempDir()
	dir := t.TempDir()
	file := filepath.Join(t.TempDir(), "hosts")
	must(t, os.WriteFile(file, []byte("127.0.0.1 localhost\n"), 0o644))
	must(t, os.MkdirAll(filepath.Join(proc, "self"), 0o755))
	mountinfo := "30 1 254:1 / " + dir + " rw,relatime - ext4 /dev/vda1 rw\n" +
		"31 30 254:1 /var/lib/docker/containers/abc/hosts " + file + " rw,relatime - ext4 /dev/vda1 rw\n"
	must(t, os.WriteFile(filepath.Join(proc, "self/mountinfo"), []byte(mountinfo), 0o644))
	d := newDiskCollector(proc, "", quietLogger())
	d.statfs = fakeStatfs(map[string]statfsResult{dir: statfsTable["/"], file: statfsTable["/"]})
	mounts, err := d.Mounts(context.Background())
	if err != nil || len(mounts) != 1 || mounts[0].Path != dir {
		t.Errorf("file bind mount must be skipped: %+v err=%v", mounts, err)
	}
}

func TestDiskCollectorHonoursContext(t *testing.T) {
	proc := t.TempDir()
	stageTree(t, proc, "proc-a")
	d := newDiskCollector(proc, "", quietLogger())
	block := make(chan struct{})
	d.statfs = func(path string) (statfsResult, error) {
		if path == "/home" {
			<-block
		}
		return statfsTable[path], nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	mounts, err := d.Mounts(ctx)
	close(block)
	if err == nil {
		t.Error("a hung statfs must surface the context error")
	}
	if len(mounts) == 0 || mounts[0].Path == "" {
		t.Errorf("mounts before the hang should still be returned: %+v", mounts)
	}
}

func TestStatfsReal(t *testing.T) {
	st, err := statfs(t.TempDir())
	if err != nil {
		t.Skip("statfs unsupported here:", err)
	}
	if st.Bsize == 0 || st.Blocks == 0 {
		t.Errorf("implausible statfs: %+v", st)
	}
}
