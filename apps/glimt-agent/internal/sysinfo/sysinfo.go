// Package sysinfo collects the static facts reported in hello: hostname, OS,
// kernel, architecture, cores, RAM and boot time.
package sysinfo

import (
	"os"
	"runtime"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/collect"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// Info is the static machine description.
type Info struct {
	Hostname string
	OS       protocol.OSInfo
	Kernel   string
	Arch     string // amd64 | arm64 | unknown
	Cores    int
	RAMBytes int64
	BootTime int64 // Unix milliseconds
}

// Collect gathers the facts. On non-Linux systems, or when /proc is not
// readable, fields are best effort and never cause a panic.
func Collect() Info {
	info := Info{
		OS:     readOSRelease(),
		Kernel: kernelRelease(),
		Arch:   Arch(runtime.GOARCH),
		Cores:  runtime.NumCPU(),
	}
	if h, err := os.Hostname(); err == nil {
		info.Hostname = h
	}
	if info.Hostname == "" {
		info.Hostname = "unknown"
	}
	if info.Cores < 1 {
		info.Cores = 1
	}
	if mem, err := collect.ReadMeminfo(); err == nil {
		info.RAMBytes = mem.Total
	}
	if st, err := collect.ReadStat(); err == nil {
		info.BootTime = st.BootTime * 1000
	}
	return info
}

// Arch maps GOARCH onto the protocol's arch enum.
func Arch(goarch string) string {
	switch goarch {
	case "amd64", "arm64":
		return goarch
	}
	return "unknown"
}
