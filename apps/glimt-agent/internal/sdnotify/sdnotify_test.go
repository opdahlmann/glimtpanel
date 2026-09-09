package sdnotify

import (
	"net"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestNoSocketIsNoop(t *testing.T) {
	t.Setenv("NOTIFY_SOCKET", "")
	if err := Ready(); err != nil {
		t.Errorf("without NOTIFY_SOCKET Ready must be a no-op, got %v", err)
	}
}

func TestSendsToUnixgram(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix sockets")
	}
	path := filepath.Join(t.TempDir(), "notify")
	l, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: path, Net: "unixgram"})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	t.Setenv("NOTIFY_SOCKET", path)
	if err := Ready(); err != nil {
		t.Fatal(err)
	}
	_ = l.SetReadDeadline(time.Now().Add(time.Second))
	buf := make([]byte, 64)
	n, err := l.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "READY=1" {
		t.Errorf("got %q", buf[:n])
	}
}
