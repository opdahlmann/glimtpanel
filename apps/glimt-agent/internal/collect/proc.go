// Package collect reads host metrics from /proc.
package collect

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// CPUTimes are the jiffy counters of one "cpu" line in /proc/stat.
type CPUTimes struct {
	User, Nice, System, Idle, IOWait, IRQ, SoftIRQ, Steal uint64
}

// Total is the sum of all counters (guest time is already included in user/nice).
func (c CPUTimes) Total() uint64 {
	return c.User + c.Nice + c.System + c.Idle + c.IOWait + c.IRQ + c.SoftIRQ + c.Steal
}

// Stat is the parsed /proc/stat.
type Stat struct {
	CPU      CPUTimes
	PerCore  []CPUTimes
	BootTime int64 // Unix seconds (btime)
}

// ParseStat parses /proc/stat.
func ParseStat(r io.Reader) (Stat, error) {
	var st Stat
	sc := bufio.NewScanner(r)
	seenTotal := false
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 0 {
			continue
		}
		switch {
		case fields[0] == "cpu":
			t, err := parseCPUTimes(fields[1:])
			if err != nil {
				return st, fmt.Errorf("/proc/stat cpu: %w", err)
			}
			st.CPU = t
			seenTotal = true
		case strings.HasPrefix(fields[0], "cpu"):
			t, err := parseCPUTimes(fields[1:])
			if err != nil {
				return st, fmt.Errorf("/proc/stat %s: %w", fields[0], err)
			}
			st.PerCore = append(st.PerCore, t)
		case fields[0] == "btime" && len(fields) > 1:
			st.BootTime, _ = strconv.ParseInt(fields[1], 10, 64)
		}
	}
	if err := sc.Err(); err != nil {
		return st, err
	}
	if !seenTotal {
		return st, errors.New("/proc/stat: no cpu line")
	}
	return st, nil
}

func parseCPUTimes(f []string) (CPUTimes, error) {
	if len(f) < 4 {
		return CPUTimes{}, fmt.Errorf("too few fields (%d)", len(f))
	}
	vals := make([]uint64, 8)
	for i := 0; i < len(vals) && i < len(f); i++ {
		v, err := strconv.ParseUint(f[i], 10, 64)
		if err != nil {
			return CPUTimes{}, err
		}
		vals[i] = v
	}
	return CPUTimes{User: vals[0], Nice: vals[1], System: vals[2], Idle: vals[3], IOWait: vals[4], IRQ: vals[5], SoftIRQ: vals[6], Steal: vals[7]}, nil
}

// CPUPercent computes busy percentages between two readings. With no
// elapsed ticks (or counters going backwards) it returns zeros.
func CPUPercent(prev, cur CPUTimes) protocol.CPU {
	total := cur.Total() - prev.Total()
	if cur.Total() < prev.Total() || total == 0 {
		return protocol.CPU{}
	}
	pct := func(d uint64) float64 { return round1(float64(d) / float64(total) * 100) }
	sub := func(a, b uint64) uint64 {
		if a < b {
			return 0
		}
		return a - b
	}
	idle := sub(cur.Idle, prev.Idle) + sub(cur.IOWait, prev.IOWait)
	return protocol.CPU{
		Total:  pct(total - idle),
		User:   pct(sub(cur.User, prev.User) + sub(cur.Nice, prev.Nice)),
		System: pct(sub(cur.System, prev.System) + sub(cur.IRQ, prev.IRQ) + sub(cur.SoftIRQ, prev.SoftIRQ)),
		IOWait: pct(sub(cur.IOWait, prev.IOWait)),
		Steal:  pct(sub(cur.Steal, prev.Steal)),
	}
}

// PerCorePercent computes the total busy percentage per core.
func PerCorePercent(prev, cur []CPUTimes) []float64 {
	if len(prev) != len(cur) || len(cur) == 0 {
		return nil
	}
	out := make([]float64, len(cur))
	for i := range cur {
		out[i] = CPUPercent(prev[i], cur[i]).Total
	}
	return out
}

func round1(v float64) float64 {
	return float64(int64(v*10+0.5)) / 10
}

// ParseMeminfo parses /proc/meminfo (values in kB) into bytes.
// used = total − free − buffers − cached, where cached includes SReclaimable
// (the same definition free(1) uses).
func ParseMeminfo(r io.Reader) (protocol.Mem, error) {
	kb := map[string]int64{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		key, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		v, err := strconv.ParseInt(fields[0], 10, 64)
		if err != nil {
			continue
		}
		kb[key] = v
	}
	if err := sc.Err(); err != nil {
		return protocol.Mem{}, err
	}
	if _, ok := kb["MemTotal"]; !ok {
		return protocol.Mem{}, errors.New("/proc/meminfo: no MemTotal")
	}
	b := func(k string) int64 { return kb[k] * 1024 }
	m := protocol.Mem{
		Total:     b("MemTotal"),
		Free:      b("MemFree"),
		Buffers:   b("Buffers"),
		Cached:    b("Cached") + b("SReclaimable"),
		SwapTotal: b("SwapTotal"),
	}
	m.Used = m.Total - m.Free - m.Buffers - m.Cached
	if m.Used < 0 {
		m.Used = 0
	}
	m.SwapUsed = m.SwapTotal - b("SwapFree")
	if m.SwapUsed < 0 {
		m.SwapUsed = 0
	}
	return m, nil
}

// ParseLoadavg parses /proc/loadavg into [1m, 5m, 15m].
func ParseLoadavg(text string) ([]float64, error) {
	f := strings.Fields(text)
	if len(f) < 3 {
		return nil, errors.New("/proc/loadavg: too few fields")
	}
	out := make([]float64, 3)
	for i := 0; i < 3; i++ {
		v, err := strconv.ParseFloat(f[i], 64)
		if err != nil {
			return nil, fmt.Errorf("/proc/loadavg: %w", err)
		}
		out[i] = v
	}
	return out, nil
}

// ParseUptime parses /proc/uptime into whole seconds.
func ParseUptime(text string) (int64, error) {
	f := strings.Fields(text)
	if len(f) < 1 {
		return 0, errors.New("/proc/uptime: empty")
	}
	v, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return 0, fmt.Errorf("/proc/uptime: %w", err)
	}
	return int64(v), nil
}

// ReadStat reads and parses /proc/stat.
func ReadStat() (Stat, error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return Stat{}, err
	}
	defer f.Close()
	return ParseStat(f)
}

// ReadMeminfo reads and parses /proc/meminfo.
func ReadMeminfo() (protocol.Mem, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return protocol.Mem{}, err
	}
	defer f.Close()
	return ParseMeminfo(f)
}

// ReadLoadavg reads and parses /proc/loadavg.
func ReadLoadavg() ([]float64, error) {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return nil, err
	}
	return ParseLoadavg(string(data))
}

// ReadUptime reads and parses /proc/uptime.
func ReadUptime() (int64, error) {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0, err
	}
	return ParseUptime(string(data))
}
