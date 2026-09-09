package collect

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"
)

func TestParseNetDev(t *testing.T) {
	dev, err := parseNetDev(strings.NewReader(fixture(t, "proc-a/net/dev")))
	if err != nil {
		t.Fatal(err)
	}
	if len(dev) != 6 {
		t.Errorf("%d interfaces, want 6", len(dev))
	}
	if e := dev["eth0"]; e.Rx != 987654321 || e.Tx != 123456789 {
		t.Errorf("eth0 = %+v", e)
	}
	if e := dev["br-0a1b2c3d4e5f"]; e.Rx != 0 || e.Tx != 0 {
		t.Errorf("bridge = %+v", e)
	}
	if _, err := parseNetDev(strings.NewReader("Inter-| Receive\n face |bytes\n")); err == nil {
		t.Error("header only must fail")
	}
}

func TestKeepIface(t *testing.T) {
	for _, n := range []string{"eth0", "enp3s0", "wlp3s0", "docker0", "br-0a1b2c3d4e5f", "bond0", "tun0", "wg0", "docker_gwbridge"} {
		if !keepIface(n) {
			t.Errorf("%s must be kept", n)
		}
	}
	for _, n := range []string{"lo", "veth1a2b3c", "sit0", "ip6tnl0"} {
		if keepIface(n) {
			t.Errorf("%s must be skipped", n)
		}
	}
}

func TestFilterIPs(t *testing.T) {
	cidr := func(s string) net.Addr {
		_, n, err := net.ParseCIDR(s)
		if err != nil {
			t.Fatal(err)
		}
		ip, _, _ := net.ParseCIDR(s)
		n.IP = ip
		return n
	}
	addrs := []net.Addr{
		cidr("fe80::1/64"),
		cidr("2001:db8::20/64"),
		cidr("127.0.0.1/8"),
		cidr("192.168.1.20/24"),
		cidr("169.254.1.1/16"),
		&net.IPAddr{IP: net.ParseIP("10.1.1.1")},
		&net.TCPAddr{IP: net.ParseIP("1.1.1.1")},
	}
	got := filterIPs(addrs)
	want := "192.168.1.20 10.1.1.1 2001:db8::20"
	if strings.Join(got, " ") != want {
		t.Errorf("filterIPs = %q, want %q", strings.Join(got, " "), want)
	}
}

func TestInterfaceAddrsReal(t *testing.T) {
	if _, err := interfaceAddrs(); err != nil {
		t.Errorf("interfaceAddrs: %v", err)
	}
}

func TestNetCollectorIfaces(t *testing.T) {
	proc := t.TempDir()
	stageTree(t, proc, "proc-a")
	clk := &clock{t: t0}
	n := newNetCollector(proc, quietLogger())
	n.addrs = func() (map[string][]string, error) { return fakeAddrs, nil }
	n.now = clk.now

	first, err := n.Ifaces(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, i := range first {
		names = append(names, i.Name)
		if i.RxBps != 0 || i.TxBps != 0 {
			t.Errorf("first sample must have zero rates: %+v", i)
		}
	}
	if got := strings.Join(names, " "); got != "br-0a1b2c3d4e5f docker0 eth0 wlp3s0" {
		t.Errorf("ifaces = %q", got)
	}
	if eth := first[2]; strings.Join(eth.IPs, ",") != "192.168.1.20,2001:db8::20" {
		t.Errorf("eth0 ips = %v", eth.IPs)
	}
	if first[1].IPs != nil {
		t.Errorf("docker0 has no addresses, got %v", first[1].IPs)
	}

	stageTree(t, proc, "proc-b")
	clk.advance(2 * time.Second)
	second, err := n.Ifaces(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if eth := second[2]; eth.RxBps != 500000 || eth.TxBps != 125000 {
		t.Errorf("eth0 rates = %v/%v, want 500000/125000", eth.RxBps, eth.TxBps)
	}
	if wl := second[3]; wl.RxBps != 5 || wl.TxBps != 0 {
		t.Errorf("wlp3s0 rates = %v/%v", wl.RxBps, wl.TxBps)
	}
	if _, err := newNetCollector(t.TempDir(), quietLogger()).Ifaces(context.Background()); err == nil {
		t.Error("missing net/dev must fail")
	}
}
