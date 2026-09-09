package collect

import (
	"bufio"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// passwdCache maps uid → user name from /etc/passwd, re-read only when the
// file's size or mtime changes (one stat per lookup round).
type passwdCache struct {
	path string

	mu      sync.Mutex
	checked time.Time
	mtime   time.Time
	size    int64
	users   map[int]string
}

func newPasswdCache(path string) *passwdCache {
	return &passwdCache{path: path}
}

// parsePasswd reads name:x:uid:… lines; malformed lines are skipped.
func parsePasswd(r io.Reader) map[int]string {
	out := map[int]string{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := sc.Text()
		if line == "" || line[0] == '#' {
			continue
		}
		f := strings.Split(line, ":")
		if len(f) < 3 {
			continue
		}
		uid, err := strconv.Atoi(f[2])
		if err != nil {
			continue
		}
		if _, dup := out[uid]; !dup {
			out[uid] = f[0]
		}
	}
	return out
}

// refresh re-reads the file when it changed. Call once per collection round.
func (p *passwdCache) refresh(now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.users != nil && now.Sub(p.checked) < time.Minute {
		return
	}
	p.checked = now
	st, err := os.Stat(p.path)
	if err != nil {
		if p.users == nil {
			p.users = map[int]string{}
		}
		return
	}
	if p.users != nil && st.ModTime().Equal(p.mtime) && st.Size() == p.size {
		return
	}
	f, err := os.Open(p.path)
	if err != nil {
		return
	}
	defer f.Close()
	p.users = parsePasswd(f)
	p.mtime, p.size = st.ModTime(), st.Size()
}

// Lookup returns the user name for uid, or the number as a string.
func (p *passwdCache) Lookup(uid int) string {
	p.mu.Lock()
	name, ok := p.users[uid]
	p.mu.Unlock()
	if ok {
		return name
	}
	return strconv.Itoa(uid)
}
