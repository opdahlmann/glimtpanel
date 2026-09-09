package collect

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

func TestParseNetSockets(t *testing.T) {
	tcp, err := parseNetSockets(strings.NewReader(fixture(t, "proc-a/net/tcp")), "tcp")
	if err != nil {
		t.Fatal(err)
	}
	if len(tcp) != 3 || tcp[0].Port != 53 || tcp[0].Inode != 21345 || tcp[1].Port != 22 || tcp[2].Port != 8080 {
		t.Errorf("tcp = %+v", tcp)
	}
	tcp6, _ := parseNetSockets(strings.NewReader(fixture(t, "proc-a/net/tcp6")), "tcp6")
	if len(tcp6) != 3 || tcp6[0].Port != 22 || tcp6[1].Port != 80 || tcp6[2].Inode != 40002 {
		t.Errorf("tcp6 = %+v", tcp6)
	}
	udp, _ := parseNetSockets(strings.NewReader(fixture(t, "proc-a/net/udp")), "udp")
	if len(udp) != 2 || udp[0].Port != 53 || udp[1].Port != 68 {
		t.Errorf("udp (connected and port-0 sockets skipped) = %+v", udp)
	}
	udp6, _ := parseNetSockets(strings.NewReader(fixture(t, "proc-a/net/udp6")), "udp6")
	if len(udp6) != 1 || udp6[0].Port != 68 || udp6[0].Proto != "udp6" {
		t.Errorf("udp6 = %+v", udp6)
	}
	if out, err := parseNetSockets(strings.NewReader("header only\n"), "tcp"); err != nil || len(out) != 0 {
		t.Errorf("header only → %v %v", out, err)
	}
}

func TestHexPort(t *testing.T) {
	if p, ok := hexPort("0100007F:1F90"); !ok || p != 8080 {
		t.Errorf("got %d %v", p, ok)
	}
	if _, ok := hexPort("nocolon"); ok {
		t.Error("no colon must fail")
	}
	if _, ok := hexPort("0100007F:ZZ"); ok {
		t.Error("bad hex must fail")
	}
}

// fdTree adds /proc/<pid>/fd symlinks and comm files to a staged proc tree.
func fdTree(t *testing.T, proc string) {
	t.Helper()
	add := func(pid int, comm string, fds map[int]string) {
		dir := filepath.Join(proc, fmt.Sprint(pid))
		must(t, os.MkdirAll(filepath.Join(dir, "fd"), 0o755))
		must(t, os.WriteFile(filepath.Join(dir, "comm"), []byte(comm+"\n"), 0o644))
		for fd, target := range fds {
			must(t, os.Symlink(target, filepath.Join(dir, "fd", fmt.Sprint(fd))))
		}
	}
	add(1234, "sshd", map[int]string{0: "/dev/null", 3: "socket:[19876]", 4: "socket:[19878]"})
	add(2222, "nginx", map[int]string{6: "socket:[40002]", 7: "anon_inode:[eventpoll]"})
	add(991, "systemd-resolve", map[int]string{12: "socket:[21345]", 13: "socket:[21346]"})
	must(t, os.MkdirAll(filepath.Join(proc, "3333"), 0o755)) // no fd dir at all
	must(t, os.MkdirAll(filepath.Join(proc, "self/fd"), 0o755))
}

func TestResolveInodes(t *testing.T) {
	proc := t.TempDir()
	stageTree(t, proc, "proc-a")
	fdTree(t, proc)
	owners := resolveInodes(proc, map[uint64]bool{19876: true, 40002: true, 99999: true})
	if len(owners) != 2 || owners[19876] != (sockOwner{1234, "sshd"}) || owners[40002] != (sockOwner{2222, "nginx"}) {
		t.Errorf("owners = %+v", owners)
	}
	if got := resolveInodes(proc, nil); len(got) != 0 {
		t.Errorf("nothing wanted → %v", got)
	}
	if got := resolveInodes(filepath.Join(proc, "missing"), map[uint64]bool{1: true}); len(got) != 0 {
		t.Errorf("missing proc → %v", got)
	}
}

func TestListeningPorts(t *testing.T) {
	proc := t.TempDir()
	stageTree(t, proc, "proc-a")
	fdTree(t, proc)
	ports := listeningPorts(proc, quietLogger())
	var got []string
	for _, p := range ports {
		got = append(got, fmt.Sprintf("%d/%s:%s/%d", p.Port, p.Proto, p.Process, p.PID))
	}
	want := "22/tcp:sshd/1234 22/tcp6:sshd/1234 53/tcp:systemd-resolve/991 53/udp:systemd-resolve/991 68/udp:/0 68/udp6:/0 80/tcp6:nginx/2222 8080/tcp:/0"
	if strings.Join(got, " ") != want {
		t.Errorf("ports = %q\nwant  %q", strings.Join(got, " "), want)
	}
	if ports := listeningPorts(t.TempDir(), quietLogger()); len(ports) != 0 {
		t.Errorf("no tables → %v", ports)
	}
}

func TestParseUnitShow(t *testing.T) {
	load, active := parseUnitShow([]byte(fixture(t, "cmd/show-fail2ban-notfound.txt")))
	if load != "not-found" || active != "inactive" {
		t.Errorf("got %q %q", load, active)
	}
	if load, active := parseUnitShow(nil); load != "" || active != "" {
		t.Errorf("empty → %q %q", load, active)
	}
}

const (
	showUFW      = "systemctl show --property=LoadState,ActiveState ufw.service"
	showFail2ban = "systemctl show --property=LoadState,ActiveState fail2ban.service"
)

func TestUnitPresence(t *testing.T) {
	r := &fakeRunner{
		out: map[string]string{
			showUFW:      fixture(t, "cmd/show-ufw-active.txt"),
			showFail2ban: fixture(t, "cmd/show-fail2ban-notfound.txt"),
			"systemctl show --property=LoadState,ActiveState a.service": fixture(t, "cmd/show-ufw-inactive.txt"),
			"systemctl show --property=LoadState,ActiveState b.service": "",
			"systemctl show --property=LoadState,ActiveState c.service": "LoadState=loaded\nActiveState=failed\n",
		},
		errs: map[string]error{
			"systemctl show --property=LoadState,ActiveState b.service": errors.New("systemctl: exit status 4: Unit b.service could not be found."),
			"systemctl show --property=LoadState,ActiveState c.service": errors.New("systemctl: exit status 1: Failed to connect to bus"),
		},
	}
	s := NewSystem(Options{Runner: r, Logger: quietLogger()}).(*system)
	ctx := context.Background()
	cases := map[string]string{
		"ufw.service":      fwActive,
		"fail2ban.service": fwNotFound,
		"a.service":        fwInactive,
		"b.service":        fwNotFound,
		"c.service":        fwNotFound,
		"missing.service":  fwNotFound, // runner says the binary is missing
	}
	for unit, want := range cases {
		if got := s.unitPresence(ctx, unit); got != want {
			t.Errorf("unitPresence(%s) = %s, want %s", unit, got, want)
		}
	}
}

type fakeCounts struct{ c SecurityCounts }

func (f fakeCounts) SecurityCounts(context.Context) SecurityCounts { return f.c }

func TestSecurityFacade(t *testing.T) {
	proc := t.TempDir()
	stageTree(t, proc, "proc-a")
	fdTree(t, proc)
	varRoot := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(varRoot, "run"), 0o755))
	var utmp []byte
	utmp = append(utmp, utmpRecord(utUserProcess, 42, "pts/0", "ole", "192.168.1.5", 1757400000, 500000)...)
	utmp = append(utmp, utmpRecord(utUserProcess, 999, "pts/1", "gone", "10.0.0.1", 1757400100, 0)...)
	must(t, os.WriteFile(filepath.Join(varRoot, "run/utmp"), utmp, 0o644))

	r := &fakeRunner{out: map[string]string{
		showUFW:      fixture(t, "cmd/show-ufw-inactive.txt"),
		showFail2ban: fixture(t, "cmd/show-fail2ban-notfound.txt"),
	}}
	counts := fakeCounts{SecurityCounts{
		SSHFailedHour: 3, SSHFailedDay: 40, UFWBlocked: 7, Fail2banBanned: 2,
		SSHLast: []protocol.SSHAttempt{{User: "root", From: "203.0.113.9", At: 1757400500000}},
	}}
	s := NewSystem(Options{ProcRoot: proc, VarRoot: varRoot, Runner: r, Counts: counts, Logger: quietLogger()})
	sec, err := s.Security(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(sec.ListeningPorts) != 8 {
		t.Errorf("%d ports", len(sec.ListeningPorts))
	}
	if len(sec.LoggedIn) != 1 || sec.LoggedIn[0] != (protocol.Login{User: "ole", From: "192.168.1.5", TTY: "pts/0", Since: 1757400000500}) {
		t.Errorf("loggedIn = %+v", sec.LoggedIn)
	}
	if sec.SSHFailed == nil || sec.SSHFailed.Hour != 3 || sec.SSHFailed.Day != 40 || len(sec.SSHFailed.Last) != 1 {
		t.Errorf("sshFailed = %+v", sec.SSHFailed)
	}
	if sec.Firewall == nil || *sec.Firewall != (protocol.Firewall{UFW: fwInactive, Fail2ban: fwNotFound, Banned: 2, Blocked: 7}) {
		t.Errorf("firewall = %+v", sec.Firewall)
	}

	// Without a counts provider sshFailed is omitted and the firewall counters stay 0.
	s = NewSystem(Options{ProcRoot: proc, VarRoot: varRoot, Runner: r, Logger: quietLogger()})
	sec, _ = s.Security(context.Background())
	if sec.SSHFailed != nil || sec.Firewall.Banned != 0 || sec.Firewall.Blocked != 0 {
		t.Errorf("without counts: %+v %+v", sec.SSHFailed, sec.Firewall)
	}
}
