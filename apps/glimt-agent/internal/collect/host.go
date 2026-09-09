package collect

import (
	"errors"
	"sync"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// HostCollector produces protocol.Host from /proc. CPU percentages are
// computed between consecutive calls, so New primes a first reading.
// Mounts and interfaces are added in later steps of the plan.
type HostCollector struct {
	mu   sync.Mutex
	prev Stat
	ok   bool
}

// NewHost returns a collector primed with the current CPU counters.
func NewHost() *HostCollector {
	h := &HostCollector{}
	if st, err := ReadStat(); err == nil {
		h.prev, h.ok = st, true
	}
	return h
}

// Host reads /proc and returns what it could gather. The returned error, if
// any, lists the parts that failed; the Host is still usable (zero values).
func (h *HostCollector) Host() (protocol.Host, error) {
	var out protocol.Host
	var errs []error

	if st, err := ReadStat(); err != nil {
		errs = append(errs, err)
	} else {
		h.mu.Lock()
		if h.ok {
			out.CPU = CPUPercent(h.prev.CPU, st.CPU)
			out.CPU.PerCore = PerCorePercent(h.prev.PerCore, st.PerCore)
		}
		h.prev, h.ok = st, true
		h.mu.Unlock()
	}
	if mem, err := ReadMeminfo(); err != nil {
		errs = append(errs, err)
	} else {
		out.Mem = mem
	}
	if load, err := ReadLoadavg(); err != nil {
		errs = append(errs, err)
	} else {
		out.Load = load
	}
	if up, err := ReadUptime(); err != nil {
		errs = append(errs, err)
	} else {
		out.UptimeSec = up
	}
	return out, errors.Join(errs...)
}
