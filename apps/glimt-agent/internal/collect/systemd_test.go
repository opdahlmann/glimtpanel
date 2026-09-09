package collect

import (
	"context"
	"errors"
	"strings"
	"testing"
)

const listUnitsCmd = "systemctl list-units --type=service --all --plain --no-legend --no-pager --output=json"

func TestParseListUnits(t *testing.T) {
	units, err := parseListUnits([]byte(fixture(t, "cmd/list-units.json")))
	if err != nil {
		t.Fatal(err)
	}
	if len(units) != 8 {
		t.Errorf("%d units, want 8 (not-found dropped)", len(units))
	}
	for _, u := range units {
		if u.Unit == "display-manager.service" {
			t.Error("not-found unit must be dropped")
		}
	}
	if u, err := parseListUnits([]byte("  \n")); err != nil || u != nil {
		t.Errorf("empty output → %v %v", u, err)
	}
	if _, err := parseListUnits([]byte("UNIT LOAD ACTIVE SUB\n")); err == nil {
		t.Error("table output must fail")
	}
}

func TestUnitState(t *testing.T) {
	cases := []struct{ active, sub, want string }{
		{"active", "running", "running"},
		{"active", "exited", "stopped"},
		{"failed", "failed", "failed"},
		{"active", "failed", "failed"},
		{"inactive", "dead", "stopped"},
		{"activating", "auto-restart", "stopped"},
	}
	for _, c := range cases {
		if got := unitState(c.active, c.sub); got != c.want {
			t.Errorf("unitState(%s, %s) = %s, want %s", c.active, c.sub, got, c.want)
		}
	}
}

func TestParseNeedrestart(t *testing.T) {
	got := parseNeedrestart([]byte(fixture(t, "cmd/needrestart-b.txt")))
	if strings.Join(got, ",") != "cron.service,ssh.service" {
		t.Errorf("got %v", got)
	}
	if got := parseNeedrestart(nil); got != nil {
		t.Errorf("empty → %v", got)
	}
}

func TestBuildServices(t *testing.T) {
	units, _ := parseListUnits([]byte(fixture(t, "cmd/list-units.json")))
	svc := buildServices(units, []string{"cron.service", "ssh.service"})
	var order []string
	for _, u := range svc.Units {
		order = append(order, u.Name+":"+u.State)
	}
	want := "noise-fail.service:failed cron.service:running snapd.service:running ssh.service:running unattended-upgrades.service:running apparmor.service:stopped systemd-fsckd.service:stopped ufw.service:stopped"
	if got := strings.Join(order, " "); got != want {
		t.Errorf("units = %q\nwant %q", got, want)
	}
	if strings.Join(svc.Failed, ",") != "noise-fail.service" || strings.Join(svc.NeedsRestart, ",") != "cron.service,ssh.service" {
		t.Errorf("failed = %v needsRestart = %v", svc.Failed, svc.NeedsRestart)
	}
	for _, u := range svc.Units {
		if want := u.Name == "cron.service" || u.Name == "ssh.service"; u.NeedsRestart != want {
			t.Errorf("%s needsRestart = %v", u.Name, u.NeedsRestart)
		}
	}
	empty := buildServices(nil, nil)
	if empty.Failed == nil || empty.NeedsRestart == nil {
		t.Error("Failed and NeedsRestart must be non-nil for the schema")
	}
}

func TestServicesFacade(t *testing.T) {
	r := &fakeRunner{out: map[string]string{
		listUnitsCmd:     fixture(t, "cmd/list-units.json"),
		"needrestart -b": fixture(t, "cmd/needrestart-b.txt"),
	}}
	s := NewSystem(Options{Runner: r, Logger: quietLogger()})
	svc, err := s.Services(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(svc.Units) != 8 || len(svc.Failed) != 1 || len(svc.NeedsRestart) != 2 {
		t.Errorf("services = %+v", svc)
	}
	// needrestart is cached across Services calls.
	if _, err := s.Services(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := r.called("needrestart"); n != 1 {
		t.Errorf("needrestart ran %d times, want 1", n)
	}
	// Maintenance forces a refresh.
	if _, err := s.Maintenance(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := r.called("needrestart"); n != 2 {
		t.Errorf("needrestart ran %d times after Maintenance, want 2", n)
	}
}

func TestServicesWithoutSystemctl(t *testing.T) {
	s := NewSystem(Options{Runner: &fakeRunner{}, Logger: quietLogger()})
	svc, err := s.Services(context.Background())
	if err != nil {
		t.Fatalf("missing systemctl must not fail the snapshot: %v", err)
	}
	if svc == nil || svc.Units != nil || len(svc.Failed) != 0 || svc.Failed == nil || svc.NeedsRestart == nil {
		t.Errorf("empty services expected, got %+v", svc)
	}
}

func TestServicesErrors(t *testing.T) {
	r := &fakeRunner{
		out:  map[string]string{listUnitsCmd: "boom"},
		errs: map[string]error{listUnitsCmd: errors.New("exit status 1: Failed to connect to bus")},
	}
	s := NewSystem(Options{Runner: r, Logger: quietLogger()})
	if svc, err := s.Services(context.Background()); err == nil || svc == nil {
		t.Errorf("bus failure must return an error and an empty struct, got %+v %v", svc, err)
	}
	r = &fakeRunner{out: map[string]string{listUnitsCmd: "not json"}}
	s = NewSystem(Options{Runner: r, Logger: quietLogger()})
	if _, err := s.Services(context.Background()); err == nil {
		t.Error("bad JSON must fail")
	}
}

func TestNeedrestartCacheFailure(t *testing.T) {
	r := &fakeRunner{
		out:  map[string]string{"needrestart -b": "NEEDRESTART-SVC: ssh.service\n"},
		errs: map[string]error{"needrestart -b": errors.New("exit status 1")},
	}
	n := &needrestartCache{runner: r, log: quietLogger()}
	svcs, avail := n.get(context.Background(), false)
	if !avail || len(svcs) != 1 {
		t.Errorf("a failing needrestart is still available: %v %v", svcs, avail)
	}
	n = &needrestartCache{runner: &fakeRunner{}, log: quietLogger()}
	if svcs, avail := n.get(context.Background(), true); avail || svcs != nil {
		t.Errorf("missing needrestart: %v %v", svcs, avail)
	}
}
