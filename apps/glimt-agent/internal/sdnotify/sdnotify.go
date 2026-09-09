// Package sdnotify implements the tiny subset of sd_notify(3) the agent
// needs: READY=1 and STOPPING=1 over $NOTIFY_SOCKET. Without the variable
// every call is a no-op.
package sdnotify

import (
	"net"
	"os"
	"strings"
)

// Ready tells systemd the service is up.
func Ready() error { return Send("READY=1") }

// Stopping tells systemd the service is shutting down.
func Stopping() error { return Send("STOPPING=1") }

// Status sets the free-text status line shown by systemctl status.
func Status(text string) error { return Send("STATUS=" + text) }

// Send writes one state line to the notify socket. Abstract sockets (names
// starting with "@") are supported.
func Send(state string) error {
	addr := os.Getenv("NOTIFY_SOCKET")
	if addr == "" {
		return nil
	}
	if strings.HasPrefix(addr, "@") {
		addr = "\x00" + addr[1:]
	}
	conn, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: addr, Net: "unixgram"})
	if err != nil {
		return err
	}
	defer conn.Close()
	_, err = conn.Write([]byte(state))
	return err
}
