package sysinfo

import "testing"

func TestArch(t *testing.T) {
	for in, want := range map[string]string{"amd64": "amd64", "arm64": "arm64", "386": "unknown", "riscv64": "unknown"} {
		if got := Arch(in); got != want {
			t.Errorf("Arch(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCollectNeverPanics(t *testing.T) {
	info := Collect()
	if info.Hostname == "" || info.Cores < 1 || info.OS.ID == "" || info.Arch == "" {
		t.Errorf("incomplete info: %+v", info)
	}
}
