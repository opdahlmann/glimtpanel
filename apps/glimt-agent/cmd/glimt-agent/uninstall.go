package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
)

const (
	unitPath   = "/etc/systemd/system/glimt-agent.service"
	dropInDir  = "/etc/systemd/system/glimt-agent.service.d"
	configDir  = "/etc/glimt-agent"
	binaryPath = "/usr/local/bin/glimt-agent"
)

// runUninstall stops and disables the unit and removes everything the
// installer created. It must run as root.
func runUninstall(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("glimt-agent uninstall", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dry := fs.Bool("dry-run", false, "print what would be removed without changing anything")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if os.Geteuid() != 0 {
		fmt.Fprintln(stderr, "glimt-agent uninstall must run as root: sudo glimt-agent uninstall")
		return 1
	}
	prefix := ""
	if *dry {
		prefix = "would "
	}
	p := func(format string, a ...any) { fmt.Fprintf(stdout, format+"\n", a...) }

	systemdRunning := dirExists("/run/systemd/system")
	systemctl, lookErr := exec.LookPath("systemctl")
	haveSystemctl := lookErr == nil
	runCtl := func(args ...string) {
		if !haveSystemctl {
			return
		}
		if *dry {
			p("would run systemctl %v", args)
			return
		}
		cmd := exec.Command(systemctl, args...)
		cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
		_ = cmd.Run()
	}

	if haveSystemctl && (systemdRunning || fileExists(unitPath)) {
		if systemdRunning {
			runCtl("disable", "--now", "glimt-agent.service")
			p("%sstopped and disabled glimt-agent.service", prefix)
		} else {
			runCtl("disable", "glimt-agent.service")
			p("%sdisabled glimt-agent.service (systemd not running)", prefix)
		}
	}

	paths := []string{unitPath, dropInDir, "/etc/systemd/system/multi-user.target.wants/glimt-agent.service", configDir, defaultStateDir, binaryPath}
	removed := 0
	for _, path := range paths {
		if _, err := os.Lstat(path); err != nil {
			continue
		}
		if *dry {
			p("would remove %s", path)
			removed++
			continue
		}
		if err := os.RemoveAll(path); err != nil {
			fmt.Fprintf(stderr, "cannot remove %s: %v\n", path, err)
			continue
		}
		p("removed %s", path)
		removed++
	}
	if systemdRunning {
		runCtl("daemon-reload")
		runCtl("reset-failed", "glimt-agent.service")
	}
	switch {
	case *dry:
		p("dry run: nothing changed (%d items)", removed)
	case removed == 0:
		p("nothing to remove")
	default:
		p("removed")
	}
	return 0
}
