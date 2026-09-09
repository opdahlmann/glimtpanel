//go:build !linux

package collect

import "errors"

// statfs is only implemented on Linux; elsewhere mounts are reported without sizes.
func statfs(string) (statfsResult, error) {
	return statfsResult{}, errors.New("statfs: not supported on this OS")
}
