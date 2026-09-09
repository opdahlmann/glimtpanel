package docker

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// statsState is what one container's previous reading left behind.
type statsState struct {
	cgroupDir string
	cpuUsec   uint64
	cpuAt     time.Time
	netRx     uint64
	netTx     uint64
	netAt     time.Time
	netOK     bool

	// /stats fallback: the previous sample and the rates derived from it,
	// reused between throttled calls.
	apiAt     time.Time
	apiOK     bool
	apiCPU    uint64 // nanoseconds
	apiRx     uint64
	apiTx     uint64
	apiMem    int64
	apiLim    int64
	apiCPUPct float64
	apiRxBps  float64
	apiTxBps  float64
}

// Stats reads cgroup v2 counters for the containers List returned and turns
// deltas since the previous call into rates. The first call for a container
// primes the counters and reports zero rates. Containers that are not
// running get zero values with their state. Errors are joined per
// container; the slice is always complete.
func (e *Engine) Stats(ctx context.Context, containers []protocol.Container) ([]protocol.ContainerStats, error) {
	now := e.now()
	out := make([]protocol.ContainerStats, 0, len(containers))
	var errs []error
	for _, c := range containers {
		st := protocol.ContainerStats{ID: c.ID, State: c.State}
		if c.State != "running" {
			out = append(out, st)
			continue
		}
		e.mu.Lock()
		full := e.byShort[c.ID]
		ins := e.inspects[full]
		state := e.stats[full]
		if state == nil && full != "" {
			state = &statsState{}
			e.stats[full] = state
		}
		e.mu.Unlock()
		if full == "" || ins == nil {
			// Not seen by List yet: nothing to read from.
			out = append(out, st)
			continue
		}
		if err := e.readStats(ctx, full, ins, state, now, &st); err != nil {
			errs = append(errs, err)
		}
		out = append(out, st)
	}
	return out, errors.Join(errs...)
}

func (e *Engine) readStats(ctx context.Context, full string, ins *inspected, s *statsState, now time.Time, st *protocol.ContainerStats) error {
	haveCgroup := false
	if dir := e.cgroupDir(full, ins.cgroupParent, s); dir != "" {
		if usec, err := readCPUStat(filepath.Join(dir, "cpu.stat")); err == nil {
			haveCgroup = true
			if !s.cpuAt.IsZero() && now.After(s.cpuAt) && usec >= s.cpuUsec {
				wall := float64(now.Sub(s.cpuAt).Microseconds())
				st.CPUPct = round1(float64(usec-s.cpuUsec) / wall * 100)
			}
			s.cpuUsec, s.cpuAt = usec, now
			st.MemBytes, st.MemLimit = e.readMemory(dir, ins.memLimit)
		} else {
			s.cgroupDir = ""
		}
	}

	// Network: /proc/<pid>/net/dev of the container's init process.
	netDone := false
	if ins.pid > 0 {
		if rx, tx, err := readNetDev(filepath.Join(e.procRoot, strconv.Itoa(ins.pid), "net", "dev")); err == nil {
			if s.netOK && now.After(s.netAt) {
				st.RxBps, st.TxBps = rate(rx, s.netRx, tx, s.netTx, now.Sub(s.netAt))
			}
			s.netRx, s.netTx, s.netAt, s.netOK = rx, tx, now, true
			netDone = true
		}
	}
	if haveCgroup && netDone {
		return nil
	}

	// Fallback: the daemon's own one-shot stats, at most every apiEvery per
	// container. Between calls the last rates are repeated.
	if !s.apiAt.IsZero() && now.Sub(s.apiAt) < e.apiEvery {
		if s.apiOK {
			if !haveCgroup {
				st.CPUPct, st.MemBytes, st.MemLimit = s.apiCPUPct, s.apiMem, s.apiLim
			}
			if !netDone {
				st.RxBps, st.TxBps = s.apiRxBps, s.apiTxBps
			}
		}
		return nil
	}
	var resp statsResponse
	err := e.c.getJSON(ctx, "/containers/"+full+"/stats", url.Values{"stream": {"false"}, "one-shot": {"true"}}, &resp)
	if err != nil {
		s.apiAt, s.apiOK = now, false
		return err
	}
	var rx, tx uint64
	for _, n := range resp.Networks {
		rx += n.RxBytes
		tx += n.TxBytes
	}
	cpu := resp.CPUStats.CPUUsage.TotalUsage
	mem := int64(resp.MemoryStats.Usage)
	if inactive, ok := resp.MemoryStats.Stats["inactive_file"]; ok && int64(inactive) < mem {
		mem -= int64(inactive)
	}
	limit := int64(resp.MemoryStats.Limit)
	if limit <= 0 {
		limit = e.hostMemTotal()
	}
	if s.apiOK && now.After(s.apiAt) {
		d := now.Sub(s.apiAt)
		s.apiRxBps, s.apiTxBps = rate(rx, s.apiRx, tx, s.apiTx, d)
		if cpu >= s.apiCPU {
			s.apiCPUPct = round1(float64(cpu-s.apiCPU) / float64(d.Nanoseconds()) * 100)
		}
	} else {
		s.apiRxBps, s.apiTxBps, s.apiCPUPct = 0, 0, 0
	}
	s.apiRx, s.apiTx, s.apiCPU, s.apiMem, s.apiLim = rx, tx, cpu, mem, limit
	s.apiAt, s.apiOK = now, true
	if !haveCgroup {
		st.CPUPct, st.MemBytes, st.MemLimit = s.apiCPUPct, mem, limit
	}
	if !netDone {
		st.RxBps, st.TxBps = s.apiRxBps, s.apiTxBps
	}
	return nil
}

// cgroupDir locates the container's cgroup v2 directory: the systemd driver
// layout, the cgroupfs layout, then HostConfig.CgroupParent. "" when none.
func (e *Engine) cgroupDir(full, parent string, s *statsState) string {
	if s.cgroupDir != "" {
		if _, err := os.Stat(filepath.Join(s.cgroupDir, "cpu.stat")); err == nil {
			return s.cgroupDir
		}
		s.cgroupDir = ""
	}
	root := filepath.Join(e.sysRoot, "fs", "cgroup")
	candidates := []string{
		filepath.Join(root, "system.slice", "docker-"+full+".scope"),
		filepath.Join(root, "docker", full),
	}
	if parent != "" {
		p := strings.TrimPrefix(parent, "/")
		if strings.HasSuffix(p, ".slice") {
			candidates = append(candidates, filepath.Join(root, p, "docker-"+full+".scope"))
		} else {
			candidates = append(candidates, filepath.Join(root, p, full))
		}
	}
	for _, dir := range candidates {
		if _, err := os.Stat(filepath.Join(dir, "cpu.stat")); err == nil {
			s.cgroupDir = dir
			return dir
		}
	}
	return ""
}

// readMemory returns memory.current minus inactive_file, and the limit:
// memory.max, else HostConfig.Memory, else the host's total RAM.
func (e *Engine) readMemory(dir string, hostConfigLimit int64) (used, limit int64) {
	if b, err := os.ReadFile(filepath.Join(dir, "memory.current")); err == nil {
		used, _ = strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "memory.stat")); err == nil {
		if inactive, ok := keyValue(b, "inactive_file"); ok && int64(inactive) < used {
			used -= int64(inactive)
		}
	}
	if b, err := os.ReadFile(filepath.Join(dir, "memory.max")); err == nil {
		if v := strings.TrimSpace(string(b)); v != "max" {
			limit, _ = strconv.ParseInt(v, 10, 64)
		}
	}
	if limit <= 0 {
		limit = hostConfigLimit
	}
	if limit <= 0 {
		limit = e.hostMemTotal()
	}
	return used, limit
}

// hostMemTotal reads MemTotal once from <ProcRoot>/meminfo.
func (e *Engine) hostMemTotal() int64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.memTotal > 0 {
		return e.memTotal
	}
	b, err := os.ReadFile(filepath.Join(e.procRoot, "meminfo"))
	if err != nil {
		return 0
	}
	if kb, ok := keyValue(b, "MemTotal:"); ok {
		e.memTotal = int64(kb) * 1024
	}
	return e.memTotal
}

// readCPUStat returns usage_usec from a cgroup v2 cpu.stat.
func readCPUStat(path string) (uint64, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	if v, ok := keyValue(b, "usage_usec"); ok {
		return v, nil
	}
	return 0, errors.New("cpu.stat: no usage_usec")
}

// keyValue finds "key value" lines in flat key/value files.
func keyValue(b []byte, key string) (uint64, bool) {
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) >= 2 && f[0] == key {
			v, err := strconv.ParseUint(f[1], 10, 64)
			return v, err == nil
		}
	}
	return 0, false
}

// readNetDev sums received and transmitted bytes over all interfaces but lo.
func readNetDev(path string) (rx, tx uint64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if name == "lo" || name == "" {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 9 {
			continue
		}
		r, _ := strconv.ParseUint(fields[0], 10, 64)
		t, _ := strconv.ParseUint(fields[8], 10, 64)
		rx += r
		tx += t
	}
	return rx, tx, sc.Err()
}

func rate(rx, prevRx, tx, prevTx uint64, d time.Duration) (float64, float64) {
	sec := d.Seconds()
	if sec <= 0 {
		return 0, 0
	}
	var r, t float64
	if rx >= prevRx {
		r = float64(rx-prevRx) / sec
	}
	if tx >= prevTx {
		t = float64(tx-prevTx) / sec
	}
	return round1(r), round1(t)
}

func round1(f float64) float64 {
	return float64(int64(f*10+0.5)) / 10
}
