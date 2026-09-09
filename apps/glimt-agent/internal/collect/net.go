package collect

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// netCounters are the cumulative rx/tx byte counters of one interface.
type netCounters struct {
	Rx, Tx uint64
}

// parseNetDev parses /proc/net/dev. Interface names may abut the colon and
// the first counter may abut the colon on the other side.
func parseNetDev(r io.Reader) (map[string]netCounters, error) {
	out := map[string]netCounters{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		f := strings.Fields(rest)
		// rx: bytes packets errs drop fifo frame compressed multicast, tx: bytes …
		if name == "" || len(f) < 9 {
			continue
		}
		rx, err1 := strconv.ParseUint(f[0], 10, 64)
		tx, err2 := strconv.ParseUint(f[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		out[name] = netCounters{Rx: rx, Tx: tx}
	}
	if err := sc.Err(); err != nil {
		return out, err
	}
	if len(out) == 0 {
		return nil, errors.New("net/dev: no interfaces")
	}
	return out, nil
}

// keepIface drops loopback, container-side veth pairs and the kernel's
// auto-created tunnel stubs; docker0, br-*, bond*, wg* and physical NICs stay.
func keepIface(name string) bool {
	switch name {
	case "lo", "sit0", "ip6tnl0", "ip6gre0", "gre0", "gretap0", "erspan0", "ip_vti0", "ip6_vti0", "tunl0":
		return false
	}
	return !strings.HasPrefix(name, "veth")
}

// interfaceAddrs returns the usable addresses per interface: IPv4 first,
// then global IPv6; loopback and link-local are left out.
func interfaceAddrs() (map[string][]string, error) {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	out := map[string][]string{}
	for _, ifc := range ifs {
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		if ips := filterIPs(addrs); len(ips) > 0 {
			out[ifc.Name] = ips
		}
	}
	return out, nil
}

func filterIPs(addrs []net.Addr) []string {
	var v4, v6 []string
	for _, a := range addrs {
		var ip net.IP
		switch v := a.(type) {
		case *net.IPNet:
			ip = v.IP
		case *net.IPAddr:
			ip = v.IP
		default:
			continue
		}
		if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
			continue
		}
		if ip4 := ip.To4(); ip4 != nil {
			v4 = append(v4, ip4.String())
		} else {
			v6 = append(v6, ip.String())
		}
	}
	return append(v4, v6...)
}

// netCollector produces protocol.Iface entries; rates are deltas between
// consecutive calls, so the first call reports 0 B/s.
type netCollector struct {
	procRoot string
	addrs    func() (map[string][]string, error)
	now      func() time.Time
	log      *slog.Logger

	mu     sync.Mutex
	prev   map[string]netCounters
	prevAt time.Time
}

func newNetCollector(procRoot string, log *slog.Logger) *netCollector {
	if log == nil {
		log = slog.Default()
	}
	return &netCollector{procRoot: procRoot, addrs: interfaceAddrs, now: time.Now, log: log}
}

// Ifaces reads /proc/net/dev and attaches addresses and rates, sorted by name.
func (n *netCollector) Ifaces(ctx context.Context) ([]protocol.Iface, error) {
	f, err := os.Open(filepath.Join(n.procRoot, "net/dev"))
	if err != nil {
		return nil, err
	}
	cur, err := parseNetDev(f)
	f.Close()
	if err != nil {
		return nil, err
	}
	addrs, err := n.addrs()
	if err != nil {
		n.log.Debug("interface addresses unavailable", "err", err)
	}
	now := n.now()

	n.mu.Lock()
	var dt float64
	if n.prev != nil {
		dt = now.Sub(n.prevAt).Seconds()
	}
	out := make([]protocol.Iface, 0, len(cur))
	for name, c := range cur {
		if !keepIface(name) {
			continue
		}
		ifc := protocol.Iface{Name: name, IPs: addrs[name]}
		if p, ok := n.prev[name]; ok && dt > 0 {
			ifc.RxBps = bytesPerSec(p.Rx, c.Rx, dt)
			ifc.TxBps = bytesPerSec(p.Tx, c.Tx, dt)
		}
		out = append(out, ifc)
	}
	n.prev, n.prevAt = cur, now
	n.mu.Unlock()

	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, ctx.Err()
}
