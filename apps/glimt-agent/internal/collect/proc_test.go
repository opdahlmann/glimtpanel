package collect

import (
	"math"
	"strings"
	"testing"
)

const statA = `cpu  2255 34 2290 22625563 6290 127 456 100 0 0
cpu0 1132 34 1441 11311718 3675 127 438 50 0 0
cpu1 1123 0 849 11313845 2614 0 18 50 0 0
intr 114930548 113199788 3 0 5 263 0 4 0 1 0 0 0 0 0 0 0
ctxt 1990473
btime 1757395200
processes 2915
procs_running 1
procs_blocked 0
softirq 183433 0 4 0 3 0 0 0 0 0 0
`

// 1000 ticks later on the total line: 500 user, 100 system, 200 idle, 100 iowait, 100 steal.
const statB = `cpu  2755 34 2390 22625763 6390 127 456 200 0 0
cpu0 1632 34 1441 11311718 3675 127 438 50 0 0
cpu1 1123 0 949 11314045 2714 0 18 150 0 0
btime 1757395200
`

func TestParseStat(t *testing.T) {
	st, err := ParseStat(strings.NewReader(statA))
	if err != nil {
		t.Fatal(err)
	}
	if st.CPU.User != 2255 || st.CPU.Idle != 22625563 || st.CPU.Steal != 100 {
		t.Errorf("cpu = %+v", st.CPU)
	}
	if len(st.PerCore) != 2 || st.PerCore[1].System != 849 {
		t.Errorf("perCore = %+v", st.PerCore)
	}
	if st.BootTime != 1757395200 {
		t.Errorf("btime = %d", st.BootTime)
	}
}

func TestCPUPercent(t *testing.T) {
	a, _ := ParseStat(strings.NewReader(statA))
	b, _ := ParseStat(strings.NewReader(statB))
	cpu := CPUPercent(a.CPU, b.CPU)
	// total delta 1000: user 500, system 100, idle 200, iowait 100, steal 100 → busy 70 %.
	if cpu.Total != 70 || cpu.User != 50 || cpu.System != 10 || cpu.IOWait != 10 || cpu.Steal != 10 {
		t.Errorf("cpu = %+v", cpu)
	}
	per := PerCorePercent(a.PerCore, b.PerCore)
	if len(per) != 2 || per[0] != 100 || math.Abs(per[1]-40) > 0.05 {
		t.Errorf("perCore = %v", per)
	}
	if z := CPUPercent(a.CPU, a.CPU); z.Total != 0 {
		t.Errorf("no elapsed ticks should give 0, got %+v", z)
	}
	if z := CPUPercent(b.CPU, a.CPU); z.Total != 0 {
		t.Errorf("counters going backwards should give 0, got %+v", z)
	}
}

func TestParseStatErrors(t *testing.T) {
	if _, err := ParseStat(strings.NewReader("intr 1 2 3\n")); err == nil {
		t.Error("missing cpu line must fail")
	}
	if _, err := ParseStat(strings.NewReader("cpu 1 x 3 4\n")); err == nil {
		t.Error("garbage must fail")
	}
}

const meminfo = `MemTotal:        8388608 kB
MemFree:          900000 kB
MemAvailable:    5000000 kB
Buffers:          120000 kB
Cached:          2000000 kB
SwapCached:            0 kB
Active:          3000000 kB
Inactive:        2000000 kB
SwapTotal:       2097152 kB
SwapFree:        2000000 kB
Dirty:               100 kB
SReclaimable:     100000 kB
SUnreclaim:        50000 kB
`

func TestParseMeminfo(t *testing.T) {
	m, err := ParseMeminfo(strings.NewReader(meminfo))
	if err != nil {
		t.Fatal(err)
	}
	const kb = 1024
	if m.Total != 8388608*kb || m.Free != 900000*kb || m.Buffers != 120000*kb {
		t.Errorf("mem = %+v", m)
	}
	if m.Cached != (2000000+100000)*kb {
		t.Errorf("cached = %d (want Cached + SReclaimable)", m.Cached)
	}
	wantUsed := int64(8388608-900000-120000-2100000) * kb
	if m.Used != wantUsed {
		t.Errorf("used = %d, want %d", m.Used, wantUsed)
	}
	if m.SwapTotal != 2097152*kb || m.SwapUsed != (2097152-2000000)*kb {
		t.Errorf("swap = %d/%d", m.SwapUsed, m.SwapTotal)
	}
	if _, err := ParseMeminfo(strings.NewReader("Nothing: 1 kB\n")); err == nil {
		t.Error("missing MemTotal must fail")
	}
}

func TestParseLoadavgAndUptime(t *testing.T) {
	load, err := ParseLoadavg("1.90 1.70 1.60 2/1234 56789\n")
	if err != nil || len(load) != 3 || load[0] != 1.9 || load[1] != 1.7 || load[2] != 1.6 {
		t.Errorf("load = %v err=%v", load, err)
	}
	if _, err := ParseLoadavg("1.0\n"); err == nil {
		t.Error("short loadavg must fail")
	}
	up, err := ParseUptime("3548000.12 14000000.00\n")
	if err != nil || up != 3548000 {
		t.Errorf("uptime = %d err=%v", up, err)
	}
	if _, err := ParseUptime(""); err == nil {
		t.Error("empty uptime must fail")
	}
}

func TestHostCollectorNeverPanics(t *testing.T) {
	h := NewHost()
	host, _ := h.Host()
	if host.Mem.Used < 0 || host.CPU.Total < 0 || host.CPU.Total > 100 {
		t.Errorf("implausible host: %+v", host)
	}
}
