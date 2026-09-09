package collect

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// HostCollector produces protocol.Host from /proc: CPU percentages between
// consecutive calls (New primes a first reading), load, memory, uptime, and
// when configured with disk and network collectors, mounts and interfaces
// whose rates are likewise deltas between calls.
type HostCollector struct {
	procRoot string
	disks    *diskCollector // nil → no mounts
	nets     *netCollector  // nil → no ifaces
	now      func() time.Time

	mu      sync.Mutex
	prev    Stat
	ok      bool
	lastAt  time.Time
	last    protocol.Host
	lastErr error
}

// NewHost returns a collector for the real /proc, /sys and network stack,
// primed with the current CPU counters.
func NewHost() *HostCollector {
	return newHostCollector(defaultProcRoot, newDiskCollector(defaultProcRoot, "/sys", nil), newNetCollector(defaultProcRoot, nil))
}

func newHostCollector(procRoot string, disks *diskCollector, nets *netCollector) *HostCollector {
	h := &HostCollector{procRoot: procRoot, disks: disks, nets: nets, now: time.Now}
	if st, err := readStat(procRoot); err == nil {
		h.prev, h.ok = st, true
	}
	return h
}

// Host reads /proc and returns what it could gather. The returned error, if
// any, lists the parts that failed; the Host is still usable (zero values).
func (h *HostCollector) Host() (protocol.Host, error) {
	return h.HostContext(context.Background())
}

// HostContext is Host with a context that bounds statfs on hung network
// mounts. Two calls closer than minSampleInterval share one reading, so a
// snapshot right after a stream tick does not see zero deltas.
func (h *HostCollector) HostContext(ctx context.Context) (protocol.Host, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	now := h.now()
	if !h.lastAt.IsZero() && now.Sub(h.lastAt) < minSampleInterval {
		return h.last, h.lastErr
	}

	var out protocol.Host
	var errs []error

	if st, err := readStat(h.procRoot); err != nil {
		errs = append(errs, err)
	} else {
		if h.ok {
			out.CPU = CPUPercent(h.prev.CPU, st.CPU)
			out.CPU.PerCore = PerCorePercent(h.prev.PerCore, st.PerCore)
		}
		h.prev, h.ok = st, true
	}
	if mem, err := readMeminfo(h.procRoot); err != nil {
		errs = append(errs, err)
	} else {
		out.Mem = mem
	}
	if load, err := readLoadavg(h.procRoot); err != nil {
		errs = append(errs, err)
	} else {
		out.Load = load
	}
	if up, err := readUptime(h.procRoot); err != nil {
		errs = append(errs, err)
	} else {
		out.UptimeSec = up
	}
	if h.disks != nil {
		mounts, err := h.disks.Mounts(ctx)
		if err != nil {
			errs = append(errs, err)
		}
		out.Mounts = mounts
	}
	if h.nets != nil {
		ifaces, err := h.nets.Ifaces(ctx)
		if err != nil {
			errs = append(errs, err)
		}
		out.Ifaces = ifaces
	}
	h.last, h.lastErr, h.lastAt = out, errors.Join(errs...), now
	return h.last, h.lastErr
}
