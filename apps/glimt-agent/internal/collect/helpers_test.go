package collect

import (
	"context"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeRunner answers commands from a map keyed by the full command line.
// Unknown commands behave like a missing binary.
type fakeRunner struct {
	out   map[string]string
	errs  map[string]error
	calls []string
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	key := strings.Join(append([]string{name}, args...), " ")
	f.calls = append(f.calls, key)
	if err, ok := f.errs[key]; ok {
		return []byte(f.out[key]), err
	}
	if out, ok := f.out[key]; ok {
		return []byte(out), nil
	}
	return nil, &exec.Error{Name: name, Err: exec.ErrNotFound}
}

func (f *fakeRunner) called(prefix string) int {
	n := 0
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func fixture(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// stageTree copies testdata/<src> over dst so a collector can be sampled
// twice against changing files.
func stageTree(t *testing.T, dst, src string) {
	t.Helper()
	root := filepath.Join("testdata", src)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
}

// clock is a settable time source for rate tests.
type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

var t0 = time.Date(2025, 9, 9, 12, 0, 0, 0, time.UTC)

// bootT0 is 100 s after the btime in the proc fixtures, for process ages.
var bootT0 = time.Unix(1757395200+100, 0)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(discard{}, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

// fakeStatfs answers statfs from a table keyed by mount path.
func fakeStatfs(table map[string]statfsResult) func(string) (statfsResult, error) {
	return func(path string) (statfsResult, error) {
		if st, ok := table[path]; ok {
			return st, nil
		}
		return statfsResult{}, os.ErrNotExist
	}
}

var statfsTable = map[string]statfsResult{
	"/":              {Bsize: 4096, Blocks: 100000000, Bfree: 30000000, Files: 25000000, Ffree: 24000000},
	"/boot/efi":      {Bsize: 4096, Blocks: 261000, Bfree: 250000, Files: 0, Ffree: 0},
	"/home":          {Bsize: 4096, Blocks: 500000000, Bfree: 50000000, Files: 100000000, Ffree: 99000000},
	"/mnt/my backup": {Bsize: 4096, Blocks: 1000000, Bfree: 500000, Files: 65536, Ffree: 60000},
	"/mnt/nas":       {Bsize: 1048576, Blocks: 3000000, Bfree: 1000000, Files: 1000, Ffree: 500},
	"/srv/projects":  {Bsize: 4096, Blocks: 500000000, Bfree: 50000000, Files: 100000000, Ffree: 99000000},
	"/mnt/sshfs":     {Bsize: 4096, Blocks: 1000, Bfree: 200, Files: 10, Ffree: 5},
	"/var/www":       {Bsize: 4096, Blocks: 100000000, Bfree: 30000000, Files: 25000000, Ffree: 24000000},
}

var fakeAddrs = map[string][]string{
	"eth0":   {"192.168.1.20", "2001:db8::20"},
	"lo":     {"127.0.0.1"},
	"wlp3s0": {"10.0.0.5"},
}

// sysTree builds a /sys/dev/block tree where 8:33 (sdc1) is a partition of 8:32 (sdc).
func sysTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	disk := filepath.Join(root, "devices/pci0000:00/0000:00:1f.2/ata3/host2/target2:0:0/2:0:0:0/block/sdc")
	part := filepath.Join(disk, "sdc1")
	if err := os.MkdirAll(part, 0o755); err != nil {
		t.Fatal(err)
	}
	must(t, os.WriteFile(filepath.Join(disk, "dev"), []byte("8:32\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(part, "dev"), []byte("8:33\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(part, "partition"), []byte("1\n"), 0o644))
	must(t, os.MkdirAll(filepath.Join(root, "dev/block"), 0o755))
	must(t, os.Symlink(part, filepath.Join(root, "dev/block/8:33")))
	must(t, os.Symlink(disk, filepath.Join(root, "dev/block/8:32")))
	return root
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
