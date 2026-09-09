package collect

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// mountInfo is one line of /proc/self/mountinfo.
type mountInfo struct {
	Dev    string // major:minor
	Root   string // root of the mount within the file system ("/" unless a subdirectory is bind-mounted)
	Path   string // mount point
	FSType string
	Source string
}

// parseMountinfo parses /proc/self/mountinfo (proc(5)). Octal escapes in
// paths (\040 for space) are decoded.
func parseMountinfo(r io.Reader) ([]mountInfo, error) {
	var out []mountInfo
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		// id parent major:minor root mountpoint options [optional…] - fstype source superoptions
		sep := -1
		for i := 6; i < len(f); i++ {
			if f[i] == "-" {
				sep = i
				break
			}
		}
		if sep < 0 || sep+2 >= len(f) {
			continue
		}
		out = append(out, mountInfo{
			Dev:    f[2],
			Root:   unescapeMount(f[3]),
			Path:   unescapeMount(f[4]),
			FSType: f[sep+1],
			Source: unescapeMount(f[sep+2]),
		})
	}
	if err := sc.Err(); err != nil {
		return out, err
	}
	if len(out) == 0 {
		return nil, errors.New("mountinfo: no mounts")
	}
	return out, nil
}

// unescapeMount decodes the \ooo escapes the kernel uses in mountinfo.
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) && isOctal(s[i+1]) && isOctal(s[i+2]) && isOctal(s[i+3]) {
			b.WriteByte((s[i+1]-'0')<<6 | (s[i+2]-'0')<<3 | (s[i+3] - '0'))
			i += 3
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func isOctal(c byte) bool { return c >= '0' && c <= '7' }

// realFS lists file systems that hold user data; everything else is pseudo,
// virtual or a container layer and is left out of the disk panel.
var realFS = map[string]bool{
	"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true, "zfs": true,
	"f2fs": true, "jfs": true, "reiserfs": true, "nfs": true, "nfs4": true, "cifs": true,
	"smb3": true, "fuse.sshfs": true, "vfat": true, "exfat": true, "ntfs": true, "ntfs3": true,
	"fuseblk": true, "hfsplus": true, "virtiofs": true, "9p": true, "ocfs2": true, "gfs2": true,
}

// skippedPathPrefixes are mount points that belong to Docker, snap or the
// kernel and never interest the user, whatever their file system type.
var skippedPathPrefixes = []string{"/var/lib/docker/", "/snap/", "/run/", "/sys/", "/proc/", "/dev/"}

func isRealFS(fstype string) bool { return realFS[fstype] }

func isSkippedPath(path string) bool {
	for _, p := range skippedPathPrefixes {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

// realMounts keeps real file systems, drops Docker/snap/kernel mount points
// and collapses bind mounts of the same device+root to the shortest path.
// The result is in mountinfo order.
func realMounts(all []mountInfo) []mountInfo {
	best := map[string]int{} // dev+root → index into out
	var out []mountInfo
	for _, m := range all {
		if !isRealFS(m.FSType) || isSkippedPath(m.Path) {
			continue
		}
		key := m.Dev + "\x00" + m.Root
		if i, ok := best[key]; ok {
			if len(m.Path) < len(out[i].Path) {
				out[i] = m
			}
			continue
		}
		best[key] = len(out)
		out = append(out, m)
	}
	return out
}

// ioCounters are the cumulative byte counters of one /proc/diskstats row.
type ioCounters struct {
	Name       string
	ReadBytes  uint64
	WriteBytes uint64
}

// parseDiskstats parses /proc/diskstats into counters keyed by major:minor.
// Sectors are always 512 bytes in this file regardless of the device.
func parseDiskstats(r io.Reader) (map[string]ioCounters, error) {
	out := map[string]ioCounters{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		// major minor name reads merged sectors_read ms writes merged sectors_written …
		if len(f) < 10 {
			continue
		}
		rd, err1 := strconv.ParseUint(f[5], 10, 64)
		wr, err2 := strconv.ParseUint(f[9], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		out[f[0]+":"+f[1]] = ioCounters{Name: f[2], ReadBytes: rd * 512, WriteBytes: wr * 512}
	}
	if err := sc.Err(); err != nil {
		return out, err
	}
	return out, nil
}

// statfsResult is the subset of statfs(2) the disk panel needs.
type statfsResult struct {
	Bsize, Blocks, Bfree, Files, Ffree uint64
}

// diskCollector produces protocol.Mount entries; rates are deltas between
// consecutive calls, so the first call reports 0 B/s.
type diskCollector struct {
	procRoot string
	sysRoot  string
	statfs   func(string) (statfsResult, error)
	now      func() time.Time
	log      *slog.Logger

	mu     sync.Mutex
	prev   map[string]ioCounters
	prevAt time.Time
}

func newDiskCollector(procRoot, sysRoot string, log *slog.Logger) *diskCollector {
	if log == nil {
		log = slog.Default()
	}
	return &diskCollector{procRoot: procRoot, sysRoot: sysRoot, statfs: statfs, now: time.Now, log: log}
}

// Mounts reads mountinfo, statfs's each real mount and attaches I/O rates.
// Mounts that cannot be statfs'ed are skipped; a ctx deadline stops waiting
// for a hung network file system and returns what was gathered so far.
func (d *diskCollector) Mounts(ctx context.Context) ([]protocol.Mount, error) {
	f, err := os.Open(filepath.Join(d.procRoot, "self/mountinfo"))
	if err != nil {
		return nil, err
	}
	all, err := parseMountinfo(f)
	f.Close()
	if err != nil {
		return nil, err
	}
	mounts := realMounts(all)

	rates := d.rates()
	out := make([]protocol.Mount, 0, len(mounts))
	for r := range d.statAll(ctx, mounts) {
		m := mounts[r.i]
		if r.err != nil {
			d.log.Debug("statfs failed", "path", m.Path, "err", r.err)
			continue
		}
		st := r.st
		pm := protocol.Mount{
			Path:        m.Path,
			FS:          m.FSType,
			Device:      m.Source,
			Total:       int64(st.Blocks * st.Bsize),
			Used:        int64((st.Blocks - min(st.Bfree, st.Blocks)) * st.Bsize),
			InodesTotal: int64(st.Files),
			InodesUsed:  int64(st.Files - min(st.Ffree, st.Files)),
		}
		if rate, ok := rates[m.Dev]; ok {
			pm.ReadBps, pm.WriteBps = rate.read, rate.write
		} else if parent := d.parentDev(m.Dev); parent != "" {
			if rate, ok := rates[parent]; ok {
				pm.ReadBps, pm.WriteBps = rate.read, rate.write
			}
		}
		out = append(out, pm)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return fullness(out[i]) > fullness(out[j]) || (fullness(out[i]) == fullness(out[j]) && out[i].Path < out[j].Path)
	})
	return out, ctx.Err()
}

func fullness(m protocol.Mount) float64 {
	if m.Total <= 0 {
		return 0
	}
	return float64(m.Used) / float64(m.Total)
}

type statResult struct {
	i   int
	st  statfsResult
	err error
}

// errNotDir marks a mount point that is a file (Docker bind-mounts
// /etc/hosts and friends that way); such mounts are skipped.
var errNotDir = errors.New("mount point is not a directory")

// statAll stats every mount in one goroutine and yields results until all
// are in or ctx is done. The channel is buffered so the goroutine never
// blocks when the caller gives up on a hung network file system.
func (d *diskCollector) statAll(ctx context.Context, mounts []mountInfo) func(func(statResult) bool) {
	ch := make(chan statResult, len(mounts))
	go func() {
		for i, m := range mounts {
			if fi, err := os.Stat(m.Path); err == nil && !fi.IsDir() {
				ch <- statResult{i: i, err: errNotDir}
				continue
			}
			st, err := d.statfs(m.Path)
			ch <- statResult{i: i, st: st, err: err}
		}
		close(ch)
	}()
	return func(yield func(statResult) bool) {
		for {
			select {
			case r, ok := <-ch:
				if !ok || !yield(r) {
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}
}

type ioRate struct{ read, write float64 }

// rates reads diskstats, computes B/s against the previous reading and
// stores the new one. Counters that went backwards give 0.
func (d *diskCollector) rates() map[string]ioRate {
	f, err := os.Open(filepath.Join(d.procRoot, "diskstats"))
	if err != nil {
		d.log.Debug("diskstats unreadable", "err", err)
		return nil
	}
	cur, err := parseDiskstats(f)
	f.Close()
	if err != nil {
		d.log.Debug("diskstats unreadable", "err", err)
		return nil
	}
	now := d.now()
	d.mu.Lock()
	defer d.mu.Unlock()
	out := map[string]ioRate{}
	if d.prev != nil {
		dt := now.Sub(d.prevAt).Seconds()
		if dt > 0 {
			for dev, c := range cur {
				p, ok := d.prev[dev]
				if !ok {
					continue
				}
				out[dev] = ioRate{read: bytesPerSec(p.ReadBytes, c.ReadBytes, dt), write: bytesPerSec(p.WriteBytes, c.WriteBytes, dt)}
			}
		}
	}
	d.prev, d.prevAt = cur, now
	return out
}

// bytesPerSec is the rate between two cumulative counters, 0 when they went backwards.
func bytesPerSec(prev, cur uint64, dt float64) float64 {
	if cur < prev || dt <= 0 {
		return 0
	}
	return float64(cur-prev) / dt
}

// parentDev returns the major:minor of the disk a partition belongs to via
// /sys/dev/block/<dev>/../dev, or "" when dev is not a partition.
func (d *diskCollector) parentDev(dev string) string {
	link := filepath.Join(d.sysRoot, "dev/block", dev)
	if _, err := os.Stat(filepath.Join(link, "partition")); err != nil {
		return ""
	}
	real, err := filepath.EvalSymlinks(link)
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(real), "dev"))
	if err != nil {
		return ""
	}
	parent := strings.TrimSpace(string(data))
	if _, _, ok := strings.Cut(parent, ":"); !ok {
		return ""
	}
	return parent
}
