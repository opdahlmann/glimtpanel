package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// maxLogLine caps one log line; longer lines are cut.
const maxLogLine = 64 << 10

// Logs follows a container's stdout and stderr and sends one LogLine per
// line to out until ctx ends or the container stops (nil error then). ref
// is a full id, a short id or a name. Non-TTY containers arrive in the
// daemon's 8-byte-header multiplexed format; TTY containers come raw.
func (e *Engine) Logs(ctx context.Context, ref string, tail int, sinceMs int64, out chan<- protocol.LogLine) error {
	_, name, tty, err := e.Resolve(ctx, ref)
	if err != nil {
		return err
	}
	q := url.Values{"follow": {"1"}, "stdout": {"1"}, "stderr": {"1"}, "timestamps": {"1"}}
	if tail >= 0 {
		q.Set("tail", strconv.Itoa(tail))
	}
	if sinceMs > 0 {
		q.Set("since", strconv.FormatInt(sinceMs/1000, 10))
	}
	resp, err := e.c.do(ctx, "/containers/"+ref+"/logs", q, true)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	emit := func(line []byte) bool {
		ts, msg := splitTimestamp(line, e.now)
		select {
		case out <- protocol.LogLine{TS: ts, Container: name, Message: msg}:
			return true
		case <-ctx.Done():
			return false
		}
	}
	err = Demux(resp.Body, tty, emit)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

// Demux reads a container log stream and calls emit per complete line
// (without the trailing newline). With tty=false the input is the
// multiplexed format: an 8-byte header {stream, 0, 0, 0, size(be32)} before
// each frame; frames may split or join lines, so partial lines are kept per
// stream. emit returns false to stop early. Returns nil at EOF.
func Demux(r io.Reader, tty bool, emit func(line []byte) bool) error {
	if tty {
		br := bufio.NewReaderSize(r, 32<<10)
		for {
			line, err := readLine(br)
			if len(line) > 0 && !emit(line) {
				return nil
			}
			if err != nil {
				if errors.Is(err, io.EOF) {
					return nil
				}
				return err
			}
		}
	}
	br := bufio.NewReaderSize(r, 32<<10)
	partial := map[byte][]byte{}
	var hdr [8]byte
	for {
		if _, err := io.ReadFull(br, hdr[:]); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				for _, rest := range partial {
					if len(rest) > 0 && !emit(rest) {
						return nil
					}
				}
				return nil
			}
			return err
		}
		stream := hdr[0]
		size := binary.BigEndian.Uint32(hdr[4:8])
		payload := make([]byte, size)
		if _, err := io.ReadFull(br, payload); err != nil {
			return err
		}
		buf := append(partial[stream], payload...)
		for {
			i := bytes.IndexByte(buf, '\n')
			if i < 0 {
				break
			}
			line := buf[:i]
			buf = buf[i+1:]
			if !emit(trimLine(line)) {
				return nil
			}
		}
		if len(buf) > maxLogLine {
			if !emit(trimLine(buf[:maxLogLine])) {
				return nil
			}
			buf = nil
		}
		partial[stream] = append([]byte(nil), buf...)
	}
}

// readLine reads up to a newline, cutting lines longer than maxLogLine.
func readLine(br *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, err := br.ReadSlice('\n')
		line = append(line, chunk...)
		if err == nil {
			return trimLine(line), nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			if len(line) >= maxLogLine {
				// Discard the rest of the line.
				for errors.Is(err, bufio.ErrBufferFull) {
					_, err = br.ReadSlice('\n')
				}
				return trimLine(line[:maxLogLine]), err
			}
			continue
		}
		return trimLine(line), err
	}
}

func trimLine(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}

// splitTimestamp takes the leading RFC3339Nano timestamp the daemon adds
// with timestamps=1 and returns Unix ms and the message; lines without one
// get the current time.
func splitTimestamp(line []byte, now func() time.Time) (int64, string) {
	s := string(line)
	if i := strings.IndexByte(s, ' '); i > 0 {
		if t, err := time.Parse(time.RFC3339Nano, s[:i]); err == nil {
			return t.UnixMilli(), s[i+1:]
		}
	}
	return now().UnixMilli(), s
}
