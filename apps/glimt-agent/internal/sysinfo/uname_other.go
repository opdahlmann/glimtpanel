//go:build !linux

package sysinfo

import "runtime"

// kernelRelease is only meaningful on Linux; elsewhere report the OS name so
// tests on developer machines still produce a value.
func kernelRelease() string { return runtime.GOOS }
