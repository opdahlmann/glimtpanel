package collect

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// listedUnit is one element of `systemctl list-units --output=json`.
type listedUnit struct {
	Unit        string `json:"unit"`
	Load        string `json:"load"`
	Active      string `json:"active"`
	Sub         string `json:"sub"`
	Description string `json:"description"`
}

// parseListUnits decodes the JSON array systemctl prints. Units systemd
// only knows by reference (load "not-found") are dropped.
func parseListUnits(data []byte) ([]listedUnit, error) {
	data = bytes.TrimSpace(data)
	if len(data) == 0 {
		return nil, nil
	}
	var units []listedUnit
	if err := json.Unmarshal(data, &units); err != nil {
		return nil, fmt.Errorf("list-units: %w", err)
	}
	out := units[:0]
	for _, u := range units {
		if u.Unit == "" || u.Load == "not-found" {
			continue
		}
		out = append(out, u)
	}
	return out, nil
}

// unitState maps ACTIVE/SUB onto the protocol's running | stopped | failed.
func unitState(active, sub string) string {
	switch {
	case active == "failed" || sub == "failed":
		return "failed"
	case active == "active" && sub == "running":
		return "running"
	}
	return "stopped"
}

// parseNeedrestart extracts the services `needrestart -b` wants restarted.
func parseNeedrestart(data []byte) []string {
	var out []string
	seen := map[string]bool{}
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		rest, ok := strings.CutPrefix(sc.Text(), "NEEDRESTART-SVC:")
		if !ok {
			continue
		}
		name := strings.TrimSpace(rest)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// buildServices merges units and the needrestart list: failed units first,
// then running, then stopped, alphabetical within each group.
func buildServices(units []listedUnit, needs []string) *protocol.Services {
	needSet := make(map[string]bool, len(needs))
	for _, n := range needs {
		needSet[n] = true
	}
	out := &protocol.Services{Failed: []string{}, NeedsRestart: append([]string{}, needs...)}
	for _, u := range units {
		state := unitState(u.Active, u.Sub)
		out.Units = append(out.Units, protocol.Unit{Name: u.Unit, State: state, NeedsRestart: needSet[u.Unit]})
		if state == "failed" {
			out.Failed = append(out.Failed, u.Unit)
		}
	}
	rank := map[string]int{"failed": 0, "running": 1, "stopped": 2}
	sort.SliceStable(out.Units, func(i, j int) bool {
		a, b := out.Units[i], out.Units[j]
		if rank[a.State] != rank[b.State] {
			return rank[a.State] < rank[b.State]
		}
		return a.Name < b.Name
	})
	sort.Strings(out.Failed)
	return out
}

// needrestartCache runs `needrestart -b` on demand and remembers the
// result, because a scan costs a second or two of CPU. Maintenance() refreshes
// it every ten minutes; Services() reuses what is there.
type needrestartCache struct {
	runner CommandRunner
	log    *slog.Logger

	mu        sync.Mutex
	loaded    bool
	available bool
	services  []string
}

// get returns the cached services and whether needrestart exists,
// refreshing first when asked to or when nothing is cached yet.
func (n *needrestartCache) get(ctx context.Context, refresh bool) ([]string, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.loaded && !refresh {
		return n.services, n.available
	}
	out, err := n.runner.Run(ctx, "needrestart", "-b")
	switch {
	case err == nil:
		n.available, n.services = true, parseNeedrestart(out)
	case isNotFound(err):
		n.available, n.services = false, nil
	default:
		// needrestart exists but failed (often: no permission to read other users' maps);
		// keep what it printed, if anything.
		n.available, n.services = true, parseNeedrestart(out)
		n.log.Debug("needrestart failed", "err", err)
	}
	n.loaded = true
	return n.services, n.available
}

var listUnitsArgs = []string{"list-units", "--type=service", "--all", "--plain", "--no-legend", "--no-pager", "--output=json"}

// Services lists systemd services. Without systemctl (a container, a
// non-systemd box) it returns an empty result and warns once per hour rather
// than failing the snapshot.
func (s *system) Services(ctx context.Context) (*protocol.Services, error) {
	empty := &protocol.Services{Failed: []string{}, NeedsRestart: []string{}}
	data, err := s.o.Runner.Run(ctx, "systemctl", listUnitsArgs...)
	if err != nil {
		if isNotFound(err) {
			s.warn.Warn("systemctl", "services unavailable: systemctl not found", "err", err)
			return empty, nil
		}
		return empty, fmt.Errorf("systemctl list-units: %w", err)
	}
	units, err := parseListUnits(data)
	if err != nil {
		return empty, err
	}
	needs, _ := s.needrestart.get(ctx, false)
	return buildServices(units, needs), nil
}
