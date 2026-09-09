package sysinfo

import "testing"

const ubuntu2204 = `PRETTY_NAME="Ubuntu 22.04.4 LTS"
NAME="Ubuntu"
VERSION_ID="22.04"
VERSION="22.04.4 LTS (Jammy Jellyfish)"
VERSION_CODENAME=jammy
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
SUPPORT_URL="https://help.ubuntu.com/"
BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"
PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"
UBUNTU_CODENAME=jammy
`

const ubuntu2404 = `PRETTY_NAME="Ubuntu 24.04.2 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.2 LTS (Noble Numbat)"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
SUPPORT_URL="https://help.ubuntu.com/"
BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"
PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"
UBUNTU_CODENAME=noble
LOGO=ubuntu-logo
`

const ubuntu2604 = `PRETTY_NAME="Ubuntu 26.04 LTS"
NAME="Ubuntu"
VERSION_ID="26.04"
VERSION="26.04 LTS (Resolute Raccoon)"
VERSION_CODENAME=resolute
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
SUPPORT_URL="https://help.ubuntu.com/"
BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"
PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"
UBUNTU_CODENAME=resolute
LOGO=ubuntu-logo
`

const debian12 = `PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
VERSION="12 (bookworm)"
VERSION_CODENAME=bookworm
ID=debian
HOME_URL="https://www.debian.org/"
SUPPORT_URL="https://www.debian.org/support"
BUG_REPORT_URL="https://bugs.debian.org/"
`

func TestParseOSRelease(t *testing.T) {
	cases := []struct {
		name, text, id, versionID, pretty string
	}{
		{"ubuntu 22.04", ubuntu2204, "ubuntu", "22.04", "Ubuntu 22.04.4 LTS"},
		{"ubuntu 24.04", ubuntu2404, "ubuntu", "24.04", "Ubuntu 24.04.2 LTS"},
		{"ubuntu 26.04", ubuntu2604, "ubuntu", "26.04", "Ubuntu 26.04 LTS"},
		{"debian 12", debian12, "debian", "12", "Debian GNU/Linux 12 (bookworm)"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ParseOSRelease(c.text)
			if got.ID != c.id || got.VersionID != c.versionID || got.PrettyName != c.pretty {
				t.Errorf("got %+v", got)
			}
		})
	}
}

func TestParseOSReleaseQuotingAndFallbacks(t *testing.T) {
	got := ParseOSRelease("# comment\nNAME='Weird OS'\nVERSION=\"1.0 \\\"beta\\\"\"\nID=weird\n\nBROKEN LINE\n")
	if got.PrettyName != `Weird OS 1.0 "beta"` {
		t.Errorf("pretty name fallback = %q", got.PrettyName)
	}
	if got.VersionID != "" || got.ID != "weird" {
		t.Errorf("got %+v", got)
	}
	empty := ParseOSRelease("")
	if empty.ID != "linux" {
		t.Errorf("empty id fallback = %q", empty.ID)
	}
}
