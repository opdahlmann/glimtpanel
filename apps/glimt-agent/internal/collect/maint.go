package collect

import (
	"bufio"
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// updatesUnknown is reported in updates/securityUpdates when neither
// update-notifier nor apt-get could tell.
const updatesUnknown = -1

// The two sentence shapes update-notifier's apt-check has written to
// /var/lib/update-notifier/updates-available (Ubuntu 20.04+ and older).
var (
	reUpdatesNew = regexp.MustCompile(`(?m)^(\d+) updates? can be applied immediately\.`)
	reUpdatesOld = regexp.MustCompile(`(?m)^(\d+) packages? can be updated\.`)
	reSecNew     = regexp.MustCompile(`(?m)^(\d+) of these updates (?:are|is) (?:a )?standard security updates?\.`)
	reSecOld     = regexp.MustCompile(`(?m)^(\d+) updates? (?:are|is) (?:a )?security updates?\.`)
)

// parseUpdatesAvailable reads the counts from the update-notifier file.
// ok is false when the text is in another locale or shape.
func parseUpdatesAvailable(text string) (updates, security int, ok bool) {
	m := reUpdatesNew.FindStringSubmatch(text)
	if m == nil {
		m = reUpdatesOld.FindStringSubmatch(text)
	}
	if m == nil {
		return 0, 0, false
	}
	updates, _ = strconv.Atoi(m[1])
	if m = reSecNew.FindStringSubmatch(text); m == nil {
		m = reSecOld.FindStringSubmatch(text)
	}
	if m != nil {
		security, _ = strconv.Atoi(m[1])
	}
	return updates, security, true
}

// parseAptSimulation counts the "Inst" lines of `apt-get -s dist-upgrade`;
// a package is a security update when it comes from a -security source.
func parseAptSimulation(text string) (updates, security int) {
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "Inst ") {
			continue
		}
		updates++
		if strings.Contains(line, "-security") {
			security++
		}
	}
	return updates, security
}

// readRebootRequired checks /var/run/reboot-required and the package list
// next to it (duplicates removed, order kept).
func readRebootRequired(varRoot string) (bool, []string) {
	if !fileExists(filepath.Join(varRoot, "run/reboot-required")) {
		return false, nil
	}
	data, err := os.ReadFile(filepath.Join(varRoot, "run/reboot-required.pkgs"))
	if err != nil {
		return true, nil
	}
	var pkgs []string
	seen := map[string]bool{}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || seen[line] {
			continue
		}
		seen[line] = true
		pkgs = append(pkgs, line)
	}
	return true, pkgs
}

var aptSimulateArgs = []string{"-n", "19", "apt-get", "-s", "-o", "Debug::NoLocking=true", "dist-upgrade"}

// Maintenance gathers reboot and update state. It refreshes the needrestart
// cache, so the scheduler should call it at the maintenance interval.
func (s *system) Maintenance(ctx context.Context) (*protocol.Maintenance, error) {
	m := &protocol.Maintenance{CheckedAt: s.now().UnixMilli()}
	m.RebootRequired, m.RebootPkgs = readRebootRequired(s.o.VarRoot)
	m.Updates, m.SecurityUpdates = s.updates(ctx)
	_, m.NeedrestartAvailable = s.needrestart.get(ctx, true)
	return m, nil
}

// updates prefers the file Ubuntu's update-notifier writes daily and falls
// back to a niced apt-get simulation.
func (s *system) updates(ctx context.Context) (int, int) {
	if data, err := os.ReadFile(filepath.Join(s.o.VarRoot, "lib/update-notifier/updates-available")); err == nil {
		if u, sec, ok := parseUpdatesAvailable(string(data)); ok {
			return u, sec
		}
	}
	out, err := s.o.Runner.Run(ctx, "nice", aptSimulateArgs...)
	if err != nil {
		if isNotFound(err) {
			s.log.Debug("apt-get not found; update counts unknown", "err", err)
		} else {
			s.warn.Warn("apt-get", "apt-get simulation failed; update counts unknown", "err", err)
		}
		return updatesUnknown, updatesUnknown
	}
	return parseAptSimulation(string(out))
}
