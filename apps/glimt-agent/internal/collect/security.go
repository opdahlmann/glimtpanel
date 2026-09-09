package collect

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// Socket states in /proc/net/{tcp,udp}.
const (
	sockListen = "0A" // TCP_LISTEN
	sockUnconn = "07" // TCP_CLOSE, which is what an unconnected UDP socket shows
)

// sockEntry is one bound socket from /proc/net/*.
type sockEntry struct {
	Port  int
	Proto string
	Inode uint64
}

// parseNetSockets parses /proc/net/tcp, tcp6, udp or udp6. TCP keeps
// LISTEN sockets; UDP keeps unconnected sockets with a local port.
func parseNetSockets(r io.Reader, proto string) ([]sockEntry, error) {
	var out []sockEntry
	sc := bufio.NewScanner(r)
	first := true
	for sc.Scan() {
		if first {
			first = false
			continue
		}
		f := strings.Fields(sc.Text())
		// sl local rem st tx:rx tr:when retrnsmt uid timeout inode …
		if len(f) < 10 {
			continue
		}
		port, ok := hexPort(f[1])
		if !ok || port == 0 {
			continue
		}
		switch {
		case strings.HasPrefix(proto, "tcp"):
			if f[3] != sockListen {
				continue
			}
		default:
			if remPort, ok := hexPort(f[2]); f[3] != sockUnconn || !ok || remPort != 0 {
				continue
			}
		}
		inode, err := strconv.ParseUint(f[9], 10, 64)
		if err != nil {
			continue
		}
		out = append(out, sockEntry{Port: port, Proto: proto, Inode: inode})
	}
	return out, sc.Err()
}

// hexPort extracts the port from "ADDR:PORT" (both hex).
func hexPort(s string) (int, bool) {
	i := strings.LastIndexByte(s, ':')
	if i < 0 {
		return 0, false
	}
	v, err := strconv.ParseUint(s[i+1:], 16, 16)
	if err != nil {
		return 0, false
	}
	return int(v), true
}

// sockOwner is the process holding a socket inode.
type sockOwner struct {
	PID  int
	Comm string
}

// resolveInodes walks /proc/<pid>/fd once and returns the owner of every
// wanted socket inode it can see. Processes it may not inspect are skipped
// silently: without CAP_SYS_PTRACE only the agent's own show up.
func resolveInodes(procRoot string, wanted map[uint64]bool) map[uint64]sockOwner {
	out := map[uint64]sockOwner{}
	if len(wanted) == 0 {
		return out
	}
	dir, err := os.Open(procRoot)
	if err != nil {
		return out
	}
	names, err := dir.Readdirnames(-1)
	dir.Close()
	if err != nil {
		return out
	}
	var buf [64]byte
	for _, name := range names {
		if name == "" || name[0] < '0' || name[0] > '9' {
			continue
		}
		pid, err := strconv.Atoi(name)
		if err != nil {
			continue
		}
		fdDir := filepath.Join(procRoot, name, "fd")
		fdd, err := os.Open(fdDir)
		if err != nil {
			continue
		}
		fds, err := fdd.Readdirnames(-1)
		fdd.Close()
		if err != nil {
			continue
		}
		comm := ""
		for _, fd := range fds {
			target, err := os.Readlink(filepath.Join(fdDir, fd))
			if err != nil || !strings.HasPrefix(target, "socket:[") {
				continue
			}
			ino, err := strconv.ParseUint(strings.TrimSuffix(target[len("socket:["):], "]"), 10, 64)
			if err != nil || !wanted[ino] {
				continue
			}
			if _, done := out[ino]; done {
				continue
			}
			if comm == "" {
				comm = readComm(filepath.Join(procRoot, name, "comm"), buf[:0])
			}
			out[ino] = sockOwner{PID: pid, Comm: comm}
			if len(out) == len(wanted) {
				return out
			}
		}
	}
	return out
}

func readComm(path string, buf []byte) string {
	data, err := readFileInto(path, buf)
	if err != nil {
		return ""
	}
	return string(bytes.TrimSpace(data))
}

// listeningPorts reads the four socket tables, attaches owners and dedupes
// port+proto (keeping an entry with a process over one without), sorted by
// port then proto.
func listeningPorts(procRoot string, log *slog.Logger) []protocol.ListeningPort {
	var socks []sockEntry
	for _, proto := range []string{"tcp", "tcp6", "udp", "udp6"} {
		f, err := os.Open(filepath.Join(procRoot, "net", proto))
		if err != nil {
			continue
		}
		entries, err := parseNetSockets(f, proto)
		f.Close()
		if err != nil {
			log.Debug("socket table unreadable", "proto", proto, "err", err)
		}
		socks = append(socks, entries...)
	}
	wanted := make(map[uint64]bool, len(socks))
	for _, s := range socks {
		wanted[s.Inode] = true
	}
	owners := resolveInodes(procRoot, wanted)

	type key struct {
		port  int
		proto string
	}
	best := map[key]protocol.ListeningPort{}
	for _, s := range socks {
		lp := protocol.ListeningPort{Port: s.Port, Proto: s.Proto}
		if o, ok := owners[s.Inode]; ok {
			lp.PID, lp.Process = o.PID, o.Comm
		}
		k := key{s.Port, s.Proto}
		if cur, ok := best[k]; !ok || (cur.PID == 0 && lp.PID != 0) {
			best[k] = lp
		}
	}
	out := make([]protocol.ListeningPort, 0, len(best))
	for _, lp := range best {
		out = append(out, lp)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Port != out[j].Port {
			return out[i].Port < out[j].Port
		}
		return out[i].Proto < out[j].Proto
	})
	return out
}

// Firewall states in the protocol.
const (
	fwActive   = "active"
	fwInactive = "inactive"
	fwNotFound = "notFound"
)

// parseUnitShow reads LoadState/ActiveState from `systemctl show`.
func parseUnitShow(out []byte) (load, active string) {
	for _, line := range strings.Split(string(out), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch k {
		case "LoadState":
			load = v
		case "ActiveState":
			active = v
		}
	}
	return load, active
}

// unitPresence asks systemd whether a unit is active, inactive or unknown.
// One `show` call answers both questions, unlike `is-active`, which prints
// "inactive" for units that do not exist.
func (s *system) unitPresence(ctx context.Context, unit string) string {
	out, err := s.o.Runner.Run(ctx, "systemctl", "show", "--property=LoadState,ActiveState", unit)
	if err != nil {
		msg := err.Error()
		if isNotFound(err) || strings.Contains(msg, "not-found") || strings.Contains(msg, "could not be found") {
			return fwNotFound
		}
		s.warn.Warn("systemctl-show-"+unit, "unit state unavailable", "unit", unit, "err", err)
		return fwNotFound
	}
	load, active := parseUnitShow(out)
	switch {
	case load == "not-found" || load == "":
		return fwNotFound
	case active == "active" || active == "reloading":
		return fwActive
	}
	return fwInactive
}

// Security gathers listening ports, logins, the firewall state and, when a
// CountsProvider is set, the journal-derived SSH/ufw/fail2ban counts.
func (s *system) Security(ctx context.Context) (*protocol.Security, error) {
	sec := &protocol.Security{
		ListeningPorts: listeningPorts(s.o.ProcRoot, s.log),
		LoggedIn:       loggedIn(s.o.VarRoot, s.o.ProcRoot),
	}
	fw := &protocol.Firewall{
		UFW:      s.unitPresence(ctx, "ufw.service"),
		Fail2ban: s.unitPresence(ctx, "fail2ban.service"),
	}
	if s.o.Counts != nil {
		c := s.o.Counts.SecurityCounts(ctx)
		sec.SSHFailed = &protocol.SSHFailed{Hour: c.SSHFailedHour, Day: c.SSHFailedDay, Last: c.SSHLast}
		fw.Blocked, fw.Banned = c.UFWBlocked, c.Fail2banBanned
	}
	sec.Firewall = fw
	return sec, ctx.Err()
}
