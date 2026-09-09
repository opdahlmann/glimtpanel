package sysinfo

import (
	"bufio"
	"os"
	"strings"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// ParseOSRelease parses the contents of /etc/os-release (os-release(5)).
func ParseOSRelease(text string) protocol.OSInfo {
	vars := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		vars[strings.TrimSpace(key)] = unquote(strings.TrimSpace(value))
	}
	info := protocol.OSInfo{
		ID:         vars["ID"],
		VersionID:  vars["VERSION_ID"],
		PrettyName: vars["PRETTY_NAME"],
	}
	if info.PrettyName == "" {
		info.PrettyName = strings.TrimSpace(vars["NAME"] + " " + vars["VERSION"])
	}
	if info.ID == "" {
		info.ID = "linux"
	}
	return info
}

// unquote removes surrounding single or double quotes and the escapes
// os-release allows inside double quotes (\" \\ \$ \`).
func unquote(v string) string {
	if len(v) >= 2 {
		switch {
		case v[0] == '"' && v[len(v)-1] == '"':
			inner := v[1 : len(v)-1]
			r := strings.NewReplacer(`\"`, `"`, `\\`, `\`, `\$`, `$`, "\\`", "`")
			return r.Replace(inner)
		case v[0] == '\'' && v[len(v)-1] == '\'':
			return v[1 : len(v)-1]
		}
	}
	return v
}

func readOSRelease() protocol.OSInfo {
	for _, p := range []string{"/etc/os-release", "/usr/lib/os-release"} {
		if data, err := os.ReadFile(p); err == nil {
			return ParseOSRelease(string(data))
		}
	}
	return protocol.OSInfo{ID: "unknown", VersionID: "", PrettyName: "Unknown"}
}
