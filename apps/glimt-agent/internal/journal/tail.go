package journal

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// WebLogPaths are the web server logs the "web" source tails when readable.
var WebLogPaths = []string{
	"/var/log/nginx/access.log",
	"/var/log/nginx/error.log",
	"/var/log/apache2/access.log",
	"/var/log/apache2/error.log",
}

// ReadablePaths filters paths down to the ones that can be opened.
func ReadablePaths(paths []string) []string {
	var out []string
	for _, p := range paths {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		f.Close()
		out = append(out, p)
	}
	return out
}

// TailOptions tune Tail; zero values are the defaults.
type TailOptions struct {
	Poll    time.Duration    // how often to look for new data and rotation, default 250 ms
	Now     func() time.Time // timestamps for the lines, default time.Now
	MaxLine int              // default 64 KiB
}

// Tail sends the last tail lines of every file, then follows them until ctx
// ends when follow is true. Rotation (a new inode at the path) and
// truncation reopen the file. Unit is the file name without extension
// prefixed by its directory ("nginx/access"). Returns ctx.Err() when
// cancelled, nil when follow is false and all files are read.
func Tail(ctx context.Context, paths []string, tail int, follow bool, out chan<- protocol.LogLine, opt TailOptions) error {
	if opt.Poll <= 0 {
		opt.Poll = 250 * time.Millisecond
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.MaxLine <= 0 {
		opt.MaxLine = 64 << 10
	}
	if len(paths) == 0 {
		return ErrUnavailable
	}
	files := make([]*tailer, 0, len(paths))
	for _, p := range paths {
		t, err := openTailer(p, tail, opt)
		if err != nil {
			continue
		}
		defer t.close()
		files = append(files, t)
	}
	if len(files) == 0 {
		return ErrUnavailable
	}
	send := func(l protocol.LogLine) bool {
		select {
		case out <- l:
			return true
		case <-ctx.Done():
			return false
		}
	}
	for _, t := range files {
		for _, l := range t.prelude {
			if !send(l) {
				return ctx.Err()
			}
		}
		t.prelude = nil
	}
	if !follow {
		return nil
	}
	ticker := time.NewTicker(opt.Poll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			for _, t := range files {
				for _, l := range t.poll() {
					if !send(l) {
						return ctx.Err()
					}
				}
			}
		}
	}
}

// tailer follows one file.
type tailer struct {
	path    string
	unit    string
	opt     TailOptions
	f       *os.File
	r       *bufio.Reader
	ino     uint64
	offset  int64
	partial []byte
	prelude []protocol.LogLine
}

func unitFor(path string) string {
	dir := filepath.Base(filepath.Dir(path))
	name := filepath.Base(path)
	if ext := filepath.Ext(name); ext != "" {
		name = name[:len(name)-len(ext)]
	}
	return dir + "/" + name
}

func openTailer(path string, tail int, opt TailOptions) (*tailer, error) {
	t := &tailer{path: path, unit: unitFor(path), opt: opt}
	if err := t.open(); err != nil {
		return nil, err
	}
	// Prelude: the last tail lines.
	if tail > 0 {
		lines, end, err := lastLines(t.f, tail, opt.MaxLine)
		if err == nil {
			for _, l := range lines {
				t.prelude = append(t.prelude, t.line(l))
			}
			t.offset = end
		}
	} else if fi, err := t.f.Stat(); err == nil {
		t.offset = fi.Size()
	}
	if _, err := t.f.Seek(t.offset, io.SeekStart); err != nil {
		return nil, err
	}
	t.r = bufio.NewReaderSize(t.f, 64<<10)
	return t, nil
}

func (t *tailer) open() error {
	f, err := os.Open(t.path)
	if err != nil {
		return err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	t.f = f
	t.ino = inode(fi)
	t.offset = 0
	t.partial = nil
	t.r = bufio.NewReaderSize(f, 64<<10)
	return nil
}

func (t *tailer) close() {
	if t.f != nil {
		t.f.Close()
		t.f = nil
	}
}

func (t *tailer) line(msg string) protocol.LogLine {
	if len(msg) > t.opt.MaxLine {
		msg = msg[:t.opt.MaxLine]
	}
	return protocol.LogLine{TS: t.opt.Now().UnixMilli(), Unit: t.unit, Message: msg}
}

// poll reads new complete lines, reopening after rotation or truncation.
func (t *tailer) poll() []protocol.LogLine {
	var lines []protocol.LogLine
	if t.f == nil {
		if err := t.open(); err != nil {
			return nil
		}
	}
	lines = append(lines, t.readNew()...)

	// Rotation: the path now names another inode. Truncation: the file got
	// shorter than what was read.
	if fi, err := os.Stat(t.path); err == nil {
		if inode(fi) != t.ino {
			t.close()
			if err := t.open(); err == nil {
				lines = append(lines, t.readNew()...)
			}
		}
	} else {
		return lines
	}
	if fi, err := t.f.Stat(); err == nil && fi.Size() < t.offset {
		if _, err := t.f.Seek(0, io.SeekStart); err == nil {
			t.offset, t.partial = 0, nil
			t.r.Reset(t.f)
			lines = append(lines, t.readNew()...)
		}
	}
	return lines
}

func (t *tailer) readNew() []protocol.LogLine {
	var lines []protocol.LogLine
	for {
		chunk, err := t.r.ReadSlice('\n')
		t.offset += int64(len(chunk))
		if err == nil {
			msg := append(t.partial, chunk[:len(chunk)-1]...)
			t.partial = nil
			lines = append(lines, t.line(trimCR(string(msg))))
			continue
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			t.partial = append(t.partial, chunk...)
			if len(t.partial) > t.opt.MaxLine {
				lines = append(lines, t.line(string(t.partial[:t.opt.MaxLine])))
				t.partial = t.partial[:0]
			}
			continue
		}
		// EOF (or error): keep the partial line for the next poll.
		t.partial = append(t.partial, chunk...)
		return lines
	}
}

func trimCR(s string) string {
	if n := len(s); n > 0 && s[n-1] == '\r' {
		return s[:n-1]
	}
	return s
}

// lastLines returns up to n complete lines from the end of f and the offset
// after the last newline (where following starts).
func lastLines(f *os.File, n, maxLine int) ([]string, int64, error) {
	fi, err := f.Stat()
	if err != nil {
		return nil, 0, err
	}
	size := fi.Size()
	end := size
	// Ignore a trailing partial line.
	if size > 0 {
		var last [1]byte
		if _, err := f.ReadAt(last[:], size-1); err == nil && last[0] != '\n' {
			if i := lastNewline(f, size); i >= 0 {
				end = i + 1
			} else {
				return nil, 0, nil
			}
		}
	}
	budget := int64(n)*int64(maxLine) + 1
	if budget > end {
		budget = end
	}
	if budget > 8<<20 {
		budget = 8 << 20
	}
	buf := make([]byte, budget)
	if _, err := f.ReadAt(buf, end-budget); err != nil && !errors.Is(err, io.EOF) {
		return nil, 0, err
	}
	var lines []string
	stop := len(buf)
	for i := stop - 1; i >= 0 && len(lines) < n; i-- {
		if buf[i] == '\n' && i != stop-1 {
			lines = append(lines, trimCR(string(buf[i+1:stop-1])))
			stop = i + 1
		}
	}
	if len(lines) < n && end-budget == 0 && stop > 0 {
		lines = append(lines, trimCR(string(buf[:stop-1])))
	}
	for i, j := 0, len(lines)-1; i < j; i, j = i+1, j-1 {
		lines[i], lines[j] = lines[j], lines[i]
	}
	return lines, end, nil
}

// lastNewline finds the last '\n' before size, reading backwards in chunks.
func lastNewline(f *os.File, size int64) int64 {
	const chunk = 4096
	buf := make([]byte, chunk)
	for pos := size; pos > 0; {
		start := pos - chunk
		if start < 0 {
			start = 0
		}
		nread, err := f.ReadAt(buf[:pos-start], start)
		if err != nil && !errors.Is(err, io.EOF) {
			return -1
		}
		for i := nread - 1; i >= 0; i-- {
			if buf[i] == '\n' {
				return start + int64(i)
			}
		}
		pos = start
	}
	return -1
}
