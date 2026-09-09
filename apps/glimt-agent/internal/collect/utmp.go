package collect

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strconv"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// struct utmp on Linux x86_64 and arm64 (utmp(5)); both are little-endian
// and lay the record out in 384 bytes:
//
//	ut_type int16 + 2 pad | ut_pid int32 | ut_line [32] | ut_id [4] | ut_user [32]
//	ut_host [256] | ut_exit 4 | ut_session int32 | ut_tv {int32 sec, int32 usec}
//	ut_addr_v6 [4]int32 | unused [20]
const (
	utmpRecordSize = 384
	utUserProcess  = 7

	utOffType = 0
	utOffPID  = 4
	utOffLine = 8
	utOffUser = 44
	utOffHost = 76
	utOffSec  = 340
	utOffUsec = 344
)

// utmpEntry is one decoded record.
type utmpEntry struct {
	Type int16
	PID  int32
	Line string
	User string
	Host string
	Sec  int32
	Usec int32
}

// parseUtmp decodes whole records; a trailing partial record is ignored.
func parseUtmp(data []byte) []utmpEntry {
	var out []utmpEntry
	for off := 0; off+utmpRecordSize <= len(data); off += utmpRecordSize {
		r := data[off : off+utmpRecordSize]
		out = append(out, utmpEntry{
			Type: int16(binary.LittleEndian.Uint16(r[utOffType:])),
			PID:  int32(binary.LittleEndian.Uint32(r[utOffPID:])),
			Line: cString(r[utOffLine : utOffLine+32]),
			User: cString(r[utOffUser : utOffUser+32]),
			Host: cString(r[utOffHost : utOffHost+256]),
			Sec:  int32(binary.LittleEndian.Uint32(r[utOffSec:])),
			Usec: int32(binary.LittleEndian.Uint32(r[utOffUsec:])),
		})
	}
	return out
}

func cString(b []byte) string {
	if i := bytes.IndexByte(b, 0); i >= 0 {
		b = b[:i]
	}
	return string(b)
}

// loggedIn lists USER_PROCESS records whose session process still exists
// (utmp keeps stale rows after a crash), in file order.
func loggedIn(varRoot, procRoot string) []protocol.Login {
	data, err := os.ReadFile(filepath.Join(varRoot, "run/utmp"))
	if err != nil {
		return nil
	}
	checkPID := fileExists(procRoot)
	var out []protocol.Login
	for _, e := range parseUtmp(data) {
		if e.Type != utUserProcess || e.User == "" {
			continue
		}
		if checkPID && e.PID > 0 && !fileExists(filepath.Join(procRoot, strconv.Itoa(int(e.PID)))) {
			continue
		}
		out = append(out, protocol.Login{
			User:  e.User,
			From:  e.Host,
			TTY:   e.Line,
			Since: int64(e.Sec)*1000 + int64(e.Usec)/1000,
		})
	}
	return out
}
