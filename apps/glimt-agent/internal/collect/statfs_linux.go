//go:build linux

package collect

import "golang.org/x/sys/unix"

// statfs returns the raw counters of the file system mounted at path.
func statfs(path string) (statfsResult, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return statfsResult{}, err
	}
	return statfsResult{
		Bsize:  uint64(st.Bsize),
		Blocks: st.Blocks,
		Bfree:  st.Bfree,
		Files:  st.Files,
		Ffree:  st.Ffree,
	}, nil
}
