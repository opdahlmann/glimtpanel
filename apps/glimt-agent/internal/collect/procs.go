package collect

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// clkTck is USER_HZ, the unit of the tick counters in /proc; 100 on every
// Linux architecture the agent is built for.
const clkTck = 100

// minSampleInterval is the shortest gap between two samples used for a
// rate; a closer call returns the previous result unchanged.
const minSampleInterval = 200 * time.Millisecond

// procSample is what one /proc/<pid>/stat contributes. comm is kept inline
// to avoid a string allocation per process per second.
type procSample struct {
	pid      int
	comm     [32]byte
	commLen  uint8
	ticks    uint64 // utime + stime
	start    uint64 // starttime in ticks since boot
	rssPages int64
	cpu      float64
	pick     bool
}

func (s *procSample) name() string { return string(s.comm[:s.commLen]) }

type prevProc struct{ start, ticks uint64 }

// procCollector walks /proc every call and keeps the previous tick counters
// per pid so CPU% can be computed. Not safe for concurrent use of the
// buffers, hence the mutex around Collect.
type procCollector struct {
	procRoot string
	pageSize int64
	now      func() time.Time
	log      *slog.Logger
	passwd   *passwdCache

	mu      sync.Mutex
	buf     []byte
	samples []procSample
	prev    map[int]prevProc
	cur     map[int]prevProc
	prevAt  time.Time
	last    []protocol.Process
	lastTot protocol.ProcessTotals
	sumCPU  float64 // sum of cpu% over all samples (100 = one core)
	sumRSS  int64   // memory estimate over all samples, see Sums

	// sums makes Collect estimate the container's memory from every
	// process's status (the container profile's fallback without a cgroup).
	sums    bool
	selfPID int
}

func newProcCollector(procRoot, etcRoot string, log *slog.Logger) *procCollector {
	if log == nil {
		log = slog.Default()
	}
	return &procCollector{
		procRoot: procRoot,
		pageSize: int64(os.Getpagesize()),
		now:      time.Now,
		log:      log,
		passwd:   newPasswdCache(filepath.Join(etcRoot, "passwd")),
		buf:      make([]byte, 4096),
		prev:     map[int]prevProc{},
		cur:      map[int]prevProc{},
	}
}

// Collect returns the union of the top N by CPU and top N by RSS, sorted by
// CPU then RSS, plus totals. CPU% is normalised so one full core is 100 %.
func (c *procCollector) Collect(ctx context.Context, topN int) ([]protocol.Process, protocol.ProcessTotals, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.now()
	if !c.prevAt.IsZero() && now.Sub(c.prevAt) < minSampleInterval {
		return c.last, c.lastTot, nil
	}

	dir, err := os.Open(c.procRoot)
	if err != nil {
		return nil, protocol.ProcessTotals{}, err
	}
	names, err := dir.Readdirnames(-1)
	dir.Close()
	if err != nil {
		return nil, protocol.ProcessTotals{}, err
	}

	st, err := readStat(c.procRoot)
	if err != nil {
		return nil, protocol.ProcessTotals{}, err
	}
	var dt float64
	if !c.prevAt.IsZero() {
		dt = now.Sub(c.prevAt).Seconds()
	}
	nowMs := now.UnixMilli()
	c.samples = c.samples[:0]
	clear(c.cur)
	for i, name := range names {
		if i&63 == 0 && ctx.Err() != nil {
			return nil, protocol.ProcessTotals{}, ctx.Err()
		}
		if name == "" || name[0] < '0' || name[0] > '9' {
			continue
		}
		data, err := c.read(filepath.Join(c.procRoot, name, "stat"))
		if err != nil {
			continue // the process is gone
		}
		var s procSample
		if err := parseProcStat(data, &s); err != nil {
			continue
		}
		p, seen := c.prev[s.pid]
		switch {
		case seen && p.start == s.start:
			if dt > 0 && s.ticks >= p.ticks {
				s.cpu = round1(float64(s.ticks-p.ticks) / clkTck / dt * 100)
			}
		case dt > 0:
			// New since the previous sample (or a reused pid): average over its
			// own lifetime so a fresh CPU hog shows up at once.
			if ageMs := nowMs - startedAtMs(st.BootTime, s.start); ageMs >= minSampleInterval.Milliseconds() {
				s.cpu = round1(float64(s.ticks) / clkTck / (float64(ageMs) / 1000) * 100)
			}
		}
		c.cur[s.pid] = prevProc{start: s.start, ticks: s.ticks}
		c.samples = append(c.samples, s)
	}
	c.prev, c.cur = c.cur, c.prev
	c.prevAt = now
	c.sumCPU, c.sumRSS = 0, 0
	if c.sums {
		c.sumCPU, c.sumRSS = c.estimateSums()
	}
	tot := protocol.ProcessTotals{Total: len(c.samples), Running: st.ProcsRunning, Blocked: st.ProcsBlocked}

	picked := pickTop(c.samples, topN)
	c.passwd.refresh(now)
	out := make([]protocol.Process, 0, len(picked))
	for _, s := range picked {
		p := protocol.Process{
			PID:       s.pid,
			Name:      s.name(),
			CPUPct:    s.cpu,
			RSSBytes:  s.rssPages * c.pageSize,
			StartedAt: startedAtMs(st.BootTime, s.start),
		}
		pidDir := filepath.Join(c.procRoot, strconv.Itoa(s.pid))
		if data, err := c.read(filepath.Join(pidDir, "status")); err == nil {
			if uid, ok := parseStatusUID(data); ok {
				p.User = c.passwd.Lookup(uid)
			}
		}
		if data, err := c.read(filepath.Join(pidDir, "cmdline")); err == nil {
			p.Cmdline = cleanCmdline(data)
		}
		if p.Cmdline == "" {
			p.Cmdline = "[" + p.Name + "]"
		}
		out = append(out, p)
	}
	c.last, c.lastTot = out, tot
	return out, tot, nil
}

// Sums returns the cpu% (100 = one core) and the memory estimate over
// every visible process except the agent itself, from the last Collect: the
// container profile's fallback when there is no cgroup to read. Memory is
// anonymous pages (RssAnon + RssShmem) summed, plus file-backed pages
// counted once (the largest RssFile), which is close to what the cgroup
// would report for a forking server; VmRSS summed would count every
// shared library once per worker. Kernels without RssAnon fall back to
// the rss field of stat.
func (c *procCollector) Sums() (cpuPct float64, rssBytes int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sumCPU, c.sumRSS
}

func (c *procCollector) estimateSums() (cpuPct float64, memBytes int64) {
	var anon, maxFile int64
	for i := range c.samples {
		s := &c.samples[i]
		if s.pid == c.selfPID {
			continue
		}
		cpuPct += s.cpu
		data, err := c.read(filepath.Join(c.procRoot, strconv.Itoa(s.pid), "status"))
		if err == nil {
			if a, f, ok := parseStatusRSS(data); ok {
				anon += a
				maxFile = max(maxFile, f)
				continue
			}
		}
		anon += s.rssPages * c.pageSize
	}
	return cpuPct, anon + maxFile
}

// parseStatusRSS reads RssAnon + RssShmem and RssFile (bytes) from /proc/<pid>/status.
func parseStatusRSS(b []byte) (anon, file int64, ok bool) {
	var seen int
	for len(b) > 0 {
		line := b
		if i := bytes.IndexByte(b, '\n'); i >= 0 {
			line, b = b[:i], b[i+1:]
		} else {
			b = nil
		}
		var dst *int64
		switch {
		case bytes.HasPrefix(line, []byte("RssAnon:")):
			dst, line = &anon, line[8:]
		case bytes.HasPrefix(line, []byte("RssShmem:")):
			dst, line = &anon, line[9:]
		case bytes.HasPrefix(line, []byte("RssFile:")):
			dst, line = &file, line[8:]
		default:
			continue
		}
		s, e := nextField(line, 0)
		v, good := parseUintBytes(line[s:e])
		if !good {
			return 0, 0, false
		}
		*dst += int64(v) * 1024
		seen++
	}
	return anon, file, seen == 3
}

// startedAtMs converts a starttime in ticks since boot to Unix milliseconds.
func startedAtMs(bootTime int64, startTicks uint64) int64 {
	return bootTime*1000 + int64(startTicks)*1000/clkTck
}

// pickTop marks the top N by CPU and the top N by RSS and returns the union
// sorted by CPU desc, RSS desc, pid asc.
func pickTop(samples []procSample, topN int) []*procSample {
	byCPU := func(a, b *procSample) int {
		if a.cpu != b.cpu {
			if a.cpu > b.cpu {
				return -1
			}
			return 1
		}
		if a.rssPages != b.rssPages {
			if a.rssPages > b.rssPages {
				return -1
			}
			return 1
		}
		return a.pid - b.pid
	}
	byRSS := func(a, b *procSample) int {
		if a.rssPages != b.rssPages {
			if a.rssPages > b.rssPages {
				return -1
			}
			return 1
		}
		return byCPU(a, b)
	}
	idx := make([]*procSample, len(samples))
	for i := range samples {
		idx[i] = &samples[i]
	}
	slices.SortFunc(idx, byCPU)
	for i := 0; i < len(idx) && i < topN; i++ {
		idx[i].pick = true
	}
	slices.SortFunc(idx, byRSS)
	for i := 0; i < len(idx) && i < topN; i++ {
		idx[i].pick = true
	}
	picked := idx[:0]
	for _, s := range idx {
		if s.pick {
			picked = append(picked, s)
		}
	}
	slices.SortFunc(picked, byCPU)
	return picked
}

// read reads a whole (small) file into the collector's reusable buffer.
func (c *procCollector) read(path string) ([]byte, error) {
	return readFileInto(path, c.buf[:0])
}

// readFileInto reads path into buf, growing it when needed, and returns the
// bytes read. Files under /proc report size 0, so it reads until EOF.
func readFileInto(path string, buf []byte) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	for {
		if len(buf) == cap(buf) {
			buf = slices.Grow(buf, 4096)
		}
		n, err := f.Read(buf[len(buf):cap(buf)])
		buf = buf[:len(buf)+n]
		if err == io.EOF || (err == nil && n == 0) {
			return buf, nil
		}
		if err != nil {
			return buf, err
		}
	}
}

// parseProcStat fills s from /proc/<pid>/stat. comm may contain spaces and
// parentheses, so the fields after it start after the last ')'.
func parseProcStat(b []byte, s *procSample) error {
	open := bytes.IndexByte(b, '(')
	close := bytes.LastIndexByte(b, ')')
	if open < 1 || close < open {
		return errors.New("stat: malformed")
	}
	pid, ok := parseUintBytes(bytes.TrimSpace(b[:open]))
	if !ok {
		return errors.New("stat: bad pid")
	}
	s.pid = int(pid)
	s.commLen = uint8(copy(s.comm[:], b[open+1:close]))
	rest := b[close+1:]
	// Fields after comm, 0-based: state utime(11) stime(12) starttime(19) rss(21).
	var utime, stime uint64
	pos := 0
	for i := 0; i <= 21; i++ {
		start, end := nextField(rest, pos)
		if start == end {
			return errors.New("stat: too few fields")
		}
		pos = end
		switch i {
		case 11, 12, 19, 21:
			v, ok := parseUintBytes(rest[start:end])
			if !ok {
				return errors.New("stat: bad number")
			}
			switch i {
			case 11:
				utime = v
			case 12:
				stime = v
			case 19:
				s.start = v
			case 21:
				s.rssPages = int64(v)
			}
		}
	}
	s.ticks = utime + stime
	return nil
}

// nextField returns the bounds of the next whitespace-separated field.
func nextField(b []byte, pos int) (int, int) {
	for pos < len(b) && isSpace(b[pos]) {
		pos++
	}
	start := pos
	for pos < len(b) && !isSpace(b[pos]) {
		pos++
	}
	return start, pos
}

func isSpace(c byte) bool { return c == ' ' || c == '\n' || c == '\t' || c == '\r' }

// parseUintBytes parses a decimal number without allocating.
func parseUintBytes(b []byte) (uint64, bool) {
	if len(b) == 0 {
		return 0, false
	}
	var v uint64
	for _, c := range b {
		if c < '0' || c > '9' {
			return 0, false
		}
		v = v*10 + uint64(c-'0')
	}
	return v, true
}

// parseStatusUID returns the effective uid from /proc/<pid>/status
// ("Uid:\treal\teffective\tsaved\tfs"), like ps and top show.
func parseStatusUID(b []byte) (int, bool) {
	for len(b) > 0 {
		line := b
		if i := bytes.IndexByte(b, '\n'); i >= 0 {
			line, b = b[:i], b[i+1:]
		} else {
			b = nil
		}
		if !bytes.HasPrefix(line, []byte("Uid:")) {
			continue
		}
		rest := line[4:]
		_, e1 := nextField(rest, 0)
		s2, e2 := nextField(rest, e1)
		if s2 == e2 {
			return 0, false
		}
		v, ok := parseUintBytes(rest[s2:e2])
		return int(v), ok
	}
	return 0, false
}

// cleanCmdline turns NUL-separated arguments into one line; an empty file
// (kernel thread) gives "".
func cleanCmdline(b []byte) string {
	b = bytes.TrimRight(b, "\x00")
	if len(b) == 0 {
		return ""
	}
	return string(bytes.ReplaceAll(b, []byte{0}, []byte{' '}))
}
