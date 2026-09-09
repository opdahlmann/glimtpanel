package collect

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

// utmpRecord builds one 384-byte struct utmp as glibc lays it out on x86_64/arm64.
func utmpRecord(typ int16, pid int32, line, user, host string, sec, usec int32) []byte {
	r := make([]byte, utmpRecordSize)
	binary.LittleEndian.PutUint16(r[utOffType:], uint16(typ))
	binary.LittleEndian.PutUint32(r[utOffPID:], uint32(pid))
	copy(r[utOffLine:utOffLine+32], line)
	copy(r[utOffUser:utOffUser+32], user)
	copy(r[utOffHost:utOffHost+256], host)
	binary.LittleEndian.PutUint32(r[utOffSec:], uint32(sec))
	binary.LittleEndian.PutUint32(r[utOffUsec:], uint32(usec))
	return r
}

func TestParseUtmp(t *testing.T) {
	var data []byte
	data = append(data, utmpRecord(2, 0, "~", "reboot", "6.8.0-45-generic", 1757300000, 0)...) // BOOT_TIME
	data = append(data, utmpRecord(utUserProcess, 4321, "pts/0", "ole", "192.168.1.5", 1757400000, 123456)...)
	data = append(data, utmpRecord(8, 4000, "pts/2", "", "", 1757399000, 0)...) // DEAD_PROCESS
	data = append(data, make([]byte, 100)...)                                   // trailing partial record
	got := parseUtmp(data)
	if len(got) != 3 {
		t.Fatalf("%d records, want 3", len(got))
	}
	e := got[1]
	if e.Type != utUserProcess || e.PID != 4321 || e.Line != "pts/0" || e.User != "ole" || e.Host != "192.168.1.5" || e.Sec != 1757400000 || e.Usec != 123456 {
		t.Errorf("record = %+v", e)
	}
	if got[0].User != "reboot" || got[2].Type != 8 {
		t.Errorf("records = %+v", got)
	}
}

func TestLoggedIn(t *testing.T) {
	varRoot := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(varRoot, "run"), 0o755))
	var data []byte
	data = append(data, utmpRecord(2, 0, "~", "reboot", "", 1757300000, 0)...)
	data = append(data, utmpRecord(utUserProcess, 42, "pts/0", "ole", "192.168.1.5", 1757400000, 500000)...)
	data = append(data, utmpRecord(utUserProcess, 1, "tty1", "root", "", 1757400100, 0)...)
	data = append(data, utmpRecord(utUserProcess, 999, "pts/1", "stale", "10.0.0.1", 1757400200, 0)...)
	data = append(data, utmpRecord(utUserProcess, 77, "pts/3", "", "", 1757400300, 0)...)
	must(t, os.WriteFile(filepath.Join(varRoot, "run/utmp"), data, 0o644))

	proc := t.TempDir()
	stageTree(t, proc, "proc-a") // pids 1, 42, 77, 4711 exist; 999 does not
	got := loggedIn(varRoot, proc)
	if len(got) != 2 {
		t.Fatalf("logins = %+v, want ole and root", got)
	}
	if got[0].User != "ole" || got[0].From != "192.168.1.5" || got[0].TTY != "pts/0" || got[0].Since != 1757400000500 {
		t.Errorf("first = %+v", got[0])
	}
	if got[1].User != "root" || got[1].From != "" || got[1].TTY != "tty1" || got[1].Since != 1757400100000 {
		t.Errorf("second = %+v", got[1])
	}

	// Without a readable /proc the pid check is skipped and stale rows show.
	if got := loggedIn(varRoot, filepath.Join(proc, "missing")); len(got) != 3 {
		t.Errorf("without proc: %+v", got)
	}
	if got := loggedIn(t.TempDir(), proc); got != nil {
		t.Errorf("missing utmp → %+v", got)
	}
}
