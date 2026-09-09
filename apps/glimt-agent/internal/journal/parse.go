package journal

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// entry is one journalctl -o json object, reduced to the fields used.
// MESSAGE and the identifier fields may be strings or byte arrays (journald
// uses arrays for non-UTF-8 or very large values).
type entry struct {
	Realtime   string          `json:"__REALTIME_TIMESTAMP"`
	Priority   string          `json:"PRIORITY"`
	Unit       json.RawMessage `json:"_SYSTEMD_UNIT"`
	Identifier json.RawMessage `json:"SYSLOG_IDENTIFIER"`
	Comm       json.RawMessage `json:"_COMM"`
	Message    json.RawMessage `json:"MESSAGE"`
}

// ParseLine turns one journalctl -o json line into a LogLine. Lines that
// are not JSON objects (or have no timestamp) are skipped (ok=false).
func ParseLine(b []byte) (protocol.LogLine, bool) {
	var e entry
	if err := json.Unmarshal(b, &e); err != nil {
		return protocol.LogLine{}, false
	}
	usec, err := strconv.ParseInt(e.Realtime, 10, 64)
	if err != nil {
		return protocol.LogLine{}, false
	}
	line := protocol.LogLine{TS: usec / 1000, Message: rawString(e.Message), Priority: MapPriority(e.Priority)}
	if unit := rawString(e.Unit); unit != "" {
		line.Unit = strings.TrimSuffix(unit, ".service")
	} else if id := rawString(e.Identifier); id != "" {
		line.Unit = id
	} else {
		line.Unit = rawString(e.Comm)
	}
	return line, true
}

// MapPriority maps a syslog priority (0–7) onto err / warn / info.
func MapPriority(p string) string {
	n, err := strconv.Atoi(p)
	if err != nil {
		return "info"
	}
	switch {
	case n <= 3:
		return "err"
	case n == 4:
		return "warn"
	}
	return "info"
}

// rawString decodes a JSON string, a JSON array of bytes, or returns "" for
// null/absent. Other shapes give their raw text.
func rawString(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	switch raw[0] {
	case '"':
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return s
		}
	case '[':
		var bytes []byte
		var nums []int
		if json.Unmarshal(raw, &nums) == nil {
			bytes = make([]byte, len(nums))
			for i, n := range nums {
				bytes[i] = byte(n)
			}
			return strings.ToValidUTF8(string(bytes), "�")
		}
	}
	return string(raw)
}
