package collect

import (
	"context"
	"errors"
	"log/slog"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestOptionsDefaults(t *testing.T) {
	o := Options{}.withDefaults()
	if o.TopProcesses != 40 || o.ProcRoot != "/proc" || o.SysRoot != "/sys" || o.EtcRoot != "/etc" || o.VarRoot != "/var" || o.Runner == nil || o.Logger == nil {
		t.Errorf("defaults = %+v", o)
	}
	if _, ok := o.Runner.(ExecRunner); !ok {
		t.Errorf("default runner = %T", o.Runner)
	}
	custom := Options{TopProcesses: 5, ProcRoot: "/p", Logger: quietLogger()}.withDefaults()
	if custom.TopProcesses != 5 || custom.ProcRoot != "/p" {
		t.Errorf("custom = %+v", custom)
	}
}

// newTestSystem stages proc-a into a temp dir and wires fakes and a clock into every collector.
func newTestSystem(t *testing.T, runner CommandRunner) (*system, string, *clock) {
	t.Helper()
	proc := t.TempDir()
	stageTree(t, proc, "proc-a")
	clk := &clock{t: t0}
	s := NewSystem(Options{
		ProcRoot: proc, SysRoot: sysTree(t), EtcRoot: "testdata/etc", VarRoot: "testdata/var",
		Runner: runner, Logger: quietLogger(),
	}).(*system)
	s.now = clk.now
	s.host.now = clk.now
	s.host.disks.now, s.host.disks.statfs = clk.now, fakeStatfs(statfsTable)
	s.host.nets.now = clk.now
	s.host.nets.addrs = func() (map[string][]string, error) { return fakeAddrs, nil }
	s.procs.now, s.procs.pageSize = clk.now, 4096
	return s, proc, clk
}

func TestSystemHostTwoSamples(t *testing.T) {
	s, proc, clk := newTestSystem(t, &fakeRunner{})
	ctx := context.Background()

	first, err := s.Host(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if first.Mem.Total != 8388608*1024 || first.UptimeSec != 86400 || len(first.Load) != 3 || first.Load[0] != 0.52 {
		t.Errorf("first = %+v", first)
	}
	if first.CPU.Total != 0 || len(first.Mounts) != 8 || len(first.Ifaces) != 4 {
		t.Errorf("first: cpu %+v mounts %d ifaces %d", first.CPU, len(first.Mounts), len(first.Ifaces))
	}

	stageTree(t, proc, "proc-b")
	clk.advance(time.Second)
	second, err := s.Host(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cpu := second.CPU
	if cpu.Total != 75 || cpu.User != 50 || cpu.System != 20 || cpu.IOWait != 5 || cpu.Steal != 5 {
		t.Errorf("cpu = %+v", cpu)
	}
	if len(cpu.PerCore) != 2 || cpu.PerCore[0] != 100 || cpu.PerCore[1] != 50 {
		t.Errorf("perCore = %v", cpu.PerCore)
	}
	if m := second.Mounts[3]; m.Path != "/" || m.ReadBps != 2048*512 || m.WriteBps != 1024*512 || m.InodesUsed != 1000000 {
		t.Errorf("root mount = %+v", m)
	}
	if i := second.Ifaces[2]; i.Name != "eth0" || i.RxBps != 1000000 || i.TxBps != 250000 || len(i.IPs) != 2 {
		t.Errorf("eth0 = %+v", i)
	}

	// A call 50 ms later shares the previous reading.
	clk.advance(50 * time.Millisecond)
	third, _ := s.Host(ctx)
	if third.CPU.Total != 75 || third.Ifaces[2].RxBps != 1000000 {
		t.Errorf("third should equal second: %+v", third.CPU)
	}
}

func TestSystemProcessesDefaultTopN(t *testing.T) {
	s, _, _ := newTestSystem(t, &fakeRunner{})
	procs, tot, err := s.Processes(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if tot.Total != 4 || len(procs) != 4 {
		t.Errorf("topN 0 → default 40 → all 4 processes, got %d (%+v)", len(procs), tot)
	}
}

func TestHostCollectorPartialFailure(t *testing.T) {
	proc := t.TempDir()
	stageTree(t, proc, "proc-a")
	h := newHostCollector(proc, nil, nil)
	host, err := h.Host()
	if err != nil || host.Mem.Total == 0 || host.Mounts != nil || host.Ifaces != nil {
		t.Errorf("without disk/net collectors: %+v %v", host, err)
	}
	h = newHostCollector(t.TempDir(), nil, nil)
	if host, err := h.Host(); err == nil || host.Mem.Total != 0 {
		t.Errorf("empty proc must report errors: %+v %v", host, err)
	}
}

func TestExecRunner(t *testing.T) {
	r := ExecRunner{Timeout: 5 * time.Second}
	ctx := context.Background()
	out, err := r.Run(ctx, "sh", "-c", "echo hello; echo oops >&2")
	if err != nil || strings.TrimSpace(string(out)) != "hello" {
		t.Errorf("out=%q err=%v", out, err)
	}
	_, err = r.Run(ctx, "sh", "-c", "echo partial; echo bad >&2; exit 3")
	if err == nil || !strings.Contains(err.Error(), "bad") || !strings.Contains(err.Error(), "exit status 3") {
		t.Errorf("stderr and status must be in the error, got %v", err)
	}
	_, err = r.Run(ctx, "glimt-definitely-missing-binary")
	if !isNotFound(err) {
		t.Errorf("missing binary → %v", err)
	}
	_, err = r.Run(ctx, "sh", "-c", "exit 127")
	if !isNotFound(err) {
		t.Errorf("exit 127 counts as not found, got %v", err)
	}
	fast := ExecRunner{Timeout: 50 * time.Millisecond}
	if _, err := fast.Run(ctx, "sleep", "5"); err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("timeout → %v", err)
	}
	if isNotFound(nil) || isNotFound(errors.New("other")) {
		t.Error("isNotFound false positives")
	}
	if !isNotFound(&exec.Error{Name: "x", Err: exec.ErrNotFound}) {
		t.Error("exec.ErrNotFound must count")
	}
}

func TestWarnLimiter(t *testing.T) {
	var buf strings.Builder
	log := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn}))
	clk := &clock{t: t0}
	w := &warnLimiter{log: log, every: time.Hour, now: clk.now}
	w.Warn("k", "first")
	w.Warn("k", "second")
	clk.advance(30 * time.Minute)
	w.Warn("k", "third")
	w.Warn("other", "fourth")
	clk.advance(31 * time.Minute)
	w.Warn("k", "fifth")
	got := buf.String()
	for _, want := range []string{"first", "fourth", "fifth"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
	for _, unwanted := range []string{"second", "third"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("%q should have been rate limited: %q", unwanted, got)
		}
	}
}
