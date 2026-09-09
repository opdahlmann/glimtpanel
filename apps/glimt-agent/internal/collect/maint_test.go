package collect

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const aptCmd = "nice -n 19 apt-get -s -o Debug::NoLocking=true dist-upgrade"

func TestParseUpdatesAvailable(t *testing.T) {
	cases := []struct {
		text              string
		updates, security int
		ok                bool
	}{
		{"\n12 updates can be applied immediately.\n5 of these updates are standard security updates.\nTo see these additional updates run: apt list --upgradable\n", 12, 5, true},
		{"1 update can be applied immediately.\n1 of these updates is a standard security update.\n", 1, 1, true},
		{"0 updates can be applied immediately.\n", 0, 0, true},
		{"7 updates can be applied immediately.\n3 additional updates can be applied with ESM Apps.\n", 7, 0, true},
		{"23 packages can be updated.\n9 updates are security updates.\n", 23, 9, true},
		{"12 oppdateringer kan tas i bruk umiddelbart.\n", 0, 0, false},
		{"", 0, 0, false},
	}
	for _, c := range cases {
		u, s, ok := parseUpdatesAvailable(c.text)
		if u != c.updates || s != c.security || ok != c.ok {
			t.Errorf("parseUpdatesAvailable(%q) = %d %d %v, want %d %d %v", c.text, u, s, ok, c.updates, c.security, c.ok)
		}
	}
}

func TestParseAptSimulation(t *testing.T) {
	u, s := parseAptSimulation(fixture(t, "cmd/apt-get-s.txt"))
	if u != 4 || s != 2 {
		t.Errorf("apt-get -s → %d updates, %d security; want 4, 2", u, s)
	}
	if u, s := parseAptSimulation("Reading package lists...\n0 upgraded, 0 newly installed\n"); u != 0 || s != 0 {
		t.Errorf("nothing to do → %d %d", u, s)
	}
}

func TestReadRebootRequired(t *testing.T) {
	req, pkgs := readRebootRequired("testdata/var")
	if !req || strings.Join(pkgs, ",") != "linux-image-6.8.0-45-generic,linux-base" {
		t.Errorf("reboot = %v %v", req, pkgs)
	}
	if req, pkgs := readRebootRequired(t.TempDir()); req || pkgs != nil {
		t.Errorf("no flag file → %v %v", req, pkgs)
	}
	dir := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(dir, "run"), 0o755))
	must(t, os.WriteFile(filepath.Join(dir, "run/reboot-required"), nil, 0o644))
	if req, pkgs := readRebootRequired(dir); !req || pkgs != nil {
		t.Errorf("flag without pkgs → %v %v", req, pkgs)
	}
}

func TestMaintenanceFacade(t *testing.T) {
	r := &fakeRunner{out: map[string]string{"needrestart -b": fixture(t, "cmd/needrestart-b.txt")}}
	s := NewSystem(Options{VarRoot: "testdata/var", Runner: r, Logger: quietLogger()}).(*system)
	s.now = func() time.Time { return t0 }
	m, err := s.Maintenance(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !m.RebootRequired || len(m.RebootPkgs) != 2 || m.Updates != 12 || m.SecurityUpdates != 5 || !m.NeedrestartAvailable || m.CheckedAt != t0.UnixMilli() {
		t.Errorf("maintenance = %+v", m)
	}
	if r.called("nice") != 0 {
		t.Error("apt-get must not run when update-notifier's file is usable")
	}
}

func TestMaintenanceAptFallback(t *testing.T) {
	r := &fakeRunner{out: map[string]string{aptCmd: fixture(t, "cmd/apt-get-s.txt")}}
	s := NewSystem(Options{VarRoot: t.TempDir(), Runner: r, Logger: quietLogger()})
	m, err := s.Maintenance(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if m.RebootRequired || m.Updates != 4 || m.SecurityUpdates != 2 || m.NeedrestartAvailable {
		t.Errorf("maintenance = %+v", m)
	}

	// A file in another locale falls back to apt-get too.
	dir := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(dir, "lib/update-notifier"), 0o755))
	must(t, os.WriteFile(filepath.Join(dir, "lib/update-notifier/updates-available"), []byte("12 oppdateringer kan tas i bruk umiddelbart.\n"), 0o644))
	s = NewSystem(Options{VarRoot: dir, Runner: r, Logger: quietLogger()})
	if m, _ := s.Maintenance(context.Background()); m.Updates != 4 {
		t.Errorf("locale fallback → %+v", m)
	}

	// Neither source: unknown.
	s = NewSystem(Options{VarRoot: t.TempDir(), Runner: &fakeRunner{}, Logger: quietLogger()})
	if m, _ := s.Maintenance(context.Background()); m.Updates != updatesUnknown || m.SecurityUpdates != updatesUnknown {
		t.Errorf("no apt → %+v", m)
	}
}
