package collect

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

func TestParseProcStat(t *testing.T) {
	var s procSample
	line := []byte("42 (my (weird) proc) R 1 42 42 34816 42 4194304 500 0 0 0 1000 500 0 0 20 0 3 0 12345 104857600 25600 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n")
	if err := parseProcStat(line, &s); err != nil {
		t.Fatal(err)
	}
	if s.pid != 42 || s.name() != "my (weird) proc" || s.ticks != 1500 || s.start != 12345 || s.rssPages != 25600 {
		t.Errorf("sample = pid %d name %q ticks %d start %d rss %d", s.pid, s.name(), s.ticks, s.start, s.rssPages)
	}
	for _, bad := range []string{"", "42 no parens", "x (a) S 1", "42 (a) S 1 2 3", "42 (a) S 1 2 3 4 5 6 7 8 9 10 x 12 13 14 15 16 17 18 19 20 21 22"} {
		if err := parseProcStat([]byte(bad), &s); err == nil {
			t.Errorf("%q must fail", bad)
		}
	}
}

func TestParseStatusUID(t *testing.T) {
	uid, ok := parseStatusUID([]byte(fixture(t, "proc-a/4711/status")))
	if !ok || uid != 0 {
		t.Errorf("effective uid = %d ok=%v, want 0 (real uid is 1000)", uid, ok)
	}
	if uid, ok := parseStatusUID([]byte("Name:\tx\nUid:\t1000\t1000\t1000\t1000\n")); !ok || uid != 1000 {
		t.Errorf("uid = %d ok=%v", uid, ok)
	}
	if _, ok := parseStatusUID([]byte("Name:\tx\nGid:\t0\n")); ok {
		t.Error("missing Uid must not be ok")
	}
	if _, ok := parseStatusUID([]byte("Uid:\t1000\n")); ok {
		t.Error("truncated Uid must not be ok")
	}
}

func TestCleanCmdline(t *testing.T) {
	if got := cleanCmdline([]byte("/usr/bin/python3\x00a b\x00--x\x00")); got != "/usr/bin/python3 a b --x" {
		t.Errorf("got %q", got)
	}
	if got := cleanCmdline(nil); got != "" {
		t.Errorf("empty → %q", got)
	}
}

func TestParseUintBytes(t *testing.T) {
	if v, ok := parseUintBytes([]byte("18446744073709551615")); !ok || v != 18446744073709551615 {
		t.Errorf("max = %d ok=%v", v, ok)
	}
	for _, bad := range []string{"", "-1", "1x"} {
		if _, ok := parseUintBytes([]byte(bad)); ok {
			t.Errorf("%q must fail", bad)
		}
	}
}

func TestReadFileInto(t *testing.T) {
	path := filepath.Join(t.TempDir(), "big")
	want := strings.Repeat("x", 10000)
	must(t, os.WriteFile(path, []byte(want), 0o644))
	got, err := readFileInto(path, make([]byte, 0, 16))
	if err != nil || string(got) != want {
		t.Errorf("len %d err %v", len(got), err)
	}
	if _, err := readFileInto(filepath.Join(t.TempDir(), "missing"), nil); err == nil {
		t.Error("missing file must fail")
	}
}

func TestPickTop(t *testing.T) {
	samples := []procSample{
		{pid: 1, cpu: 5, rssPages: 100},
		{pid: 2, cpu: 50, rssPages: 10},
		{pid: 3, cpu: 0, rssPages: 1000},
		{pid: 4, cpu: 20, rssPages: 20},
		{pid: 5, cpu: 0, rssPages: 5},
	}
	got := pickTop(samples, 2)
	var pids []int
	for _, s := range got {
		pids = append(pids, s.pid)
	}
	// top-2 cpu = {2, 4}, top-2 rss = {3, 1}; union sorted by cpu desc.
	if len(pids) != 4 || pids[0] != 2 || pids[1] != 4 || pids[2] != 1 || pids[3] != 3 {
		t.Errorf("pids = %v", pids)
	}
	if got := pickTop(samples, 100); len(got) != 5 {
		t.Errorf("topN above count must return all, got %d", len(got))
	}
	if got := pickTop(nil, 5); len(got) != 0 {
		t.Errorf("empty input → %d", len(got))
	}
}

func newTestProcCollector(t *testing.T) (*procCollector, string, *clock) {
	t.Helper()
	proc := t.TempDir()
	stageTree(t, proc, "proc-a")
	clk := &clock{t: bootT0}
	c := newProcCollector(proc, "testdata/etc", quietLogger())
	c.pageSize, c.now = 4096, clk.now
	return c, proc, clk
}

func TestProcCollectorTwoSamples(t *testing.T) {
	c, proc, clk := newTestProcCollector(t)
	ctx := context.Background()

	first, tot, err := c.Collect(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if tot != (protocol.ProcessTotals{Total: 4, Running: 2, Blocked: 1}) {
		t.Errorf("totals = %+v", tot)
	}
	if len(first) != 2 || first[0].PID != 42 || first[1].PID != 1 {
		t.Errorf("first sample (all cpu 0, ordered by rss) = %+v", first)
	}
	for _, p := range first {
		if p.CPUPct != 0 {
			t.Errorf("first sample must have cpu 0: %+v", p)
		}
	}

	stageTree(t, proc, "proc-b")
	clk.advance(time.Second)
	second, tot, err := c.Collect(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if tot != (protocol.ProcessTotals{Total: 5, Running: 3, Blocked: 0}) {
		t.Errorf("totals = %+v", tot)
	}
	// top-2 cpu = {42: 250 %, 5000: 100 %}, top-2 rss = {5000, 42} → the union is those two.
	if len(second) != 2 {
		t.Fatalf("union of top-2 cpu and top-2 rss should have 2 entries, got %+v", second)
	}
	weird, pg := second[0], second[1]
	if weird.PID != 42 || weird.CPUPct != 250 || weird.Name != "my (weird) proc" || weird.User != "ole" || weird.RSSBytes != 25600*4096 {
		t.Errorf("pid 42 = %+v", weird)
	}
	if weird.Cmdline != "/usr/bin/python3 /home/ole/my weird proc.py --flag" {
		t.Errorf("cmdline = %q", weird.Cmdline)
	}
	// pid 5000 started 0.5 s before this sample and used 50 ticks: averaged over its lifetime.
	if pg.PID != 5000 || pg.CPUPct != 100 || pg.User != "4242" || pg.RSSBytes != 100000*4096 || pg.StartedAt != 1757395300500 {
		t.Errorf("pid 5000 (new, unknown uid) = %+v", pg)
	}

	// A call right after the previous one returns the same result without rescanning.
	clk.advance(50 * time.Millisecond)
	again, _, _ := c.Collect(ctx, 2)
	if len(again) != 2 || again[0].CPUPct != 250 {
		t.Errorf("cached result expected, got %+v", again)
	}
}

func TestProcCollectorKernelThreadAndReuse(t *testing.T) {
	c, proc, clk := newTestProcCollector(t)
	ctx := context.Background()
	if _, _, err := c.Collect(ctx, 10); err != nil {
		t.Fatal(err)
	}
	stageTree(t, proc, "proc-b")
	clk.advance(time.Second)
	all, _, err := c.Collect(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	byPID := map[int]int{}
	for i, p := range all {
		byPID[p.PID] = i
	}
	if i, ok := byPID[4711]; !ok {
		t.Error("kernel thread missing")
	} else if p := all[i]; p.Cmdline != "[kworker/0:1]" || p.User != "root" || p.CPUPct != 0 {
		t.Errorf("kworker = %+v", p)
	}
	if i, ok := byPID[77]; !ok {
		t.Error("reused pid missing")
	} else if p := all[i]; p.CPUPct != 0 || p.Name != "cat" || p.StartedAt != 1757395202000 {
		t.Errorf("reused pid must not inherit the old counters: %+v", p)
	}
	if i, ok := byPID[1]; !ok {
		t.Error("pid 1 missing")
	} else if p := all[i]; p.CPUPct != 15 || p.User != "root" || p.Cmdline != "/sbin/init splash" || p.StartedAt != 1757395200050 {
		t.Errorf("pid 1 = %+v", p)
	}
	if len(all) != 5 {
		t.Errorf("%d processes, want 5", len(all))
	}
}

func TestProcCollectorErrors(t *testing.T) {
	c := newProcCollector(filepath.Join(t.TempDir(), "nope"), "testdata/etc", quietLogger())
	if _, _, err := c.Collect(context.Background(), 5); err == nil {
		t.Error("missing proc root must fail")
	}
	proc := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(proc, "1"), 0o755))
	c = newProcCollector(proc, "testdata/etc", quietLogger())
	if _, _, err := c.Collect(context.Background(), 5); err == nil {
		t.Error("missing /proc/stat must fail")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c, _, _ = newTestProcCollector(t)
	if _, _, err := c.Collect(ctx, 5); err == nil {
		t.Error("cancelled context must fail")
	}
}
