package docker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// Options for an Engine.
type Options struct {
	Client   *Client
	ProcRoot string // default /proc
	SysRoot  string // default /sys
	Now      func() time.Time
	Logger   *slog.Logger
	// InspectTTL bounds how long an inspect result is reused when no event
	// invalidates it. Default 5 min.
	InspectTTL time.Duration
	// StatsAPIInterval throttles the /stats fallback per container. Default 5 s.
	StatsAPIInterval time.Duration
}

// Engine reads containers from one daemon and remembers what it needs
// between calls: inspect results (refreshed on events), image creation
// times, cgroup locations and the previous counters for rates.
type Engine struct {
	c        *Client
	procRoot string
	sysRoot  string
	now      func() time.Time
	log      *slog.Logger
	ttl      time.Duration
	apiEvery time.Duration

	reachable  atomic.Bool
	negotiated atomic.Bool

	mu       sync.Mutex
	inspects map[string]*inspected // by full id
	images   map[string]int64      // image id → created ms
	byShort  map[string]string     // 12-char id → full id
	stats    map[string]*statsState
	memTotal int64
}

// inspected is the cached part of GET /containers/{id}/json.
type inspected struct {
	at           time.Time
	fullID       string
	name         string
	pid          int
	tty          bool
	restartCount int
	startedAt    int64
	health       string
	cgroupParent string
	memLimit     int64
}

// NewEngine builds an Engine; nothing is contacted until the first call.
func NewEngine(o Options) *Engine {
	if o.ProcRoot == "" {
		o.ProcRoot = "/proc"
	}
	if o.SysRoot == "" {
		o.SysRoot = "/sys"
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.InspectTTL <= 0 {
		o.InspectTTL = 5 * time.Minute
	}
	if o.StatsAPIInterval <= 0 {
		o.StatsAPIInterval = 5 * time.Second
	}
	return &Engine{
		c: o.Client, procRoot: o.ProcRoot, sysRoot: o.SysRoot, now: o.Now, log: o.Logger,
		ttl: o.InspectTTL, apiEvery: o.StatsAPIInterval,
		inspects: map[string]*inspected{}, images: map[string]int64{}, byShort: map[string]string{}, stats: map[string]*statsState{},
	}
}

// Client returns the underlying API client.
func (e *Engine) Client() *Client { return e.c }

// Reachable reports whether the last API call succeeded.
func (e *Engine) Reachable() bool { return e.reachable.Load() }

// ensureVersion negotiates once; later requests carry /v{version}.
func (e *Engine) ensureVersion(ctx context.Context) error {
	if e.negotiated.Load() {
		return nil
	}
	if _, err := e.c.Negotiate(ctx); err != nil {
		e.reachable.Store(false)
		return err
	}
	e.negotiated.Store(true)
	return nil
}

// List returns every container (running or not) as protocol.Container,
// without the rate fields; Stats fills those in.
func (e *Engine) List(ctx context.Context) ([]protocol.Container, error) {
	if err := e.ensureVersion(ctx); err != nil {
		return nil, err
	}
	var summaries []containerSummary
	if err := e.c.getJSON(ctx, "/containers/json", url.Values{"all": {"1"}}, &summaries); err != nil {
		e.reachable.Store(false)
		return nil, err
	}
	e.reachable.Store(true)

	out := make([]protocol.Container, 0, len(summaries))
	seen := map[string]bool{}
	usedImages := map[string]bool{}
	for _, s := range summaries {
		seen[s.ID] = true
		usedImages[s.ImageID] = true
		c := protocol.Container{
			ID:      shortID(s.ID),
			Name:    containerName(s.Names),
			Image:   s.Image,
			State:   mapState(s.State),
			Ports:   formatPorts(s.Ports),
			Mounts:  formatMounts(s.Mounts),
			Compose: s.Labels["com.docker.compose.project"],
		}
		if created, err := e.imageCreated(ctx, s.ImageID); err == nil {
			c.ImageCreated = created
		} else {
			e.log.Debug("image inspect failed", "image", s.Image, "err", err)
		}
		ins, err := e.inspect(ctx, s.ID)
		if err != nil {
			e.log.Debug("container inspect failed", "container", c.Name, "err", err)
			c.Health = "none"
		} else {
			c.Health = ins.health
			if c.State != "running" {
				// The daemon keeps the last health of a stopped container.
				c.Health = "none"
			}
			c.RestartCount = ins.restartCount
			c.StartedAt = ins.startedAt
			if ins.name != "" {
				c.Name = ins.name
			}
		}
		out = append(out, c)
	}

	e.mu.Lock()
	for id := range e.inspects {
		if !seen[id] {
			delete(e.inspects, id)
			delete(e.stats, id)
		}
	}
	for id := range e.images {
		if !usedImages[id] {
			delete(e.images, id)
		}
	}
	e.byShort = make(map[string]string, len(summaries))
	for _, s := range summaries {
		e.byShort[shortID(s.ID)] = s.ID
	}
	e.mu.Unlock()
	return out, nil
}

// inspect returns the cached inspect result or fetches it.
func (e *Engine) inspect(ctx context.Context, ref string) (*inspected, error) {
	e.mu.Lock()
	if ins, ok := e.inspects[ref]; ok && e.now().Sub(ins.at) < e.ttl {
		e.mu.Unlock()
		return ins, nil
	}
	e.mu.Unlock()

	var raw containerInspect
	if err := e.c.getJSON(ctx, "/containers/"+ref+"/json", nil, &raw); err != nil {
		return nil, err
	}
	ins := &inspected{
		at:           e.now(),
		fullID:       raw.ID,
		name:         strings.TrimPrefix(raw.Name, "/"),
		pid:          raw.State.Pid,
		tty:          raw.Config.Tty,
		restartCount: raw.RestartCount,
		startedAt:    parseTimeMs(raw.State.StartedAt),
		health:       "none",
		cgroupParent: raw.HostConfig.CgroupParent,
		memLimit:     raw.HostConfig.Memory,
	}
	if raw.State.Health != nil {
		switch raw.State.Health.Status {
		case "healthy", "unhealthy", "starting":
			ins.health = raw.State.Health.Status
		}
	}
	if raw.ID != "" {
		e.mu.Lock()
		e.inspects[raw.ID] = ins
		e.byShort[shortID(raw.ID)] = raw.ID
		e.mu.Unlock()
	}
	return ins, nil
}

// invalidate drops the inspect cache for one container (events).
func (e *Engine) invalidate(id string) {
	e.mu.Lock()
	delete(e.inspects, id)
	e.mu.Unlock()
}

func (e *Engine) imageCreated(ctx context.Context, imageID string) (int64, error) {
	if imageID == "" {
		return 0, errors.New("no image id")
	}
	e.mu.Lock()
	if ms, ok := e.images[imageID]; ok {
		e.mu.Unlock()
		return ms, nil
	}
	e.mu.Unlock()
	var raw imageInspect
	if err := e.c.getJSON(ctx, "/images/"+imageID+"/json", nil, &raw); err != nil {
		return 0, err
	}
	ms := parseTimeMs(raw.Created)
	e.mu.Lock()
	e.images[imageID] = ms
	e.mu.Unlock()
	return ms, nil
}

// Resolve finds a container by full id, short id or name and returns its
// full id, name and whether it runs with a TTY.
func (e *Engine) Resolve(ctx context.Context, ref string) (fullID, name string, tty bool, err error) {
	if err := e.ensureVersion(ctx); err != nil {
		return "", "", false, err
	}
	e.mu.Lock()
	full := e.byShort[ref]
	e.mu.Unlock()
	if full == "" {
		full = ref
	}
	ins, err := e.inspect(ctx, full)
	if err != nil {
		return "", "", false, err
	}
	return ins.fullID, ins.name, ins.tty, nil
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func containerName(names []string) string {
	if len(names) == 0 {
		return ""
	}
	return strings.TrimPrefix(names[0], "/")
}

// mapState maps the daemon's status onto the schema enum.
func mapState(s string) string {
	switch s {
	case "running", "restarting", "paused", "created", "dead":
		return s
	case "exited", "removing":
		return "stopped"
	}
	return "stopped"
}

// formatPorts renders published ports as "host→container" (with "/udp" for
// UDP), deduplicating the IPv4/IPv6 pairs Docker lists for 0.0.0.0 and ::.
func formatPorts(ports []portSummary) []string {
	seen := map[string]bool{}
	var out []string
	for _, p := range ports {
		if p.PublicPort == 0 {
			continue
		}
		s := fmt.Sprintf("%d→%d", p.PublicPort, p.PrivatePort)
		if p.Type != "" && p.Type != "tcp" {
			s += "/" + p.Type
		}
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

// formatMounts renders mounts as "source → destination"; named volumes show
// their name instead of the daemon-internal path.
func formatMounts(mounts []mountSummary) []string {
	var out []string
	for _, m := range mounts {
		src := m.Source
		if m.Type == "volume" && m.Name != "" {
			src = m.Name
		}
		if src == "" {
			src = m.Type
		}
		out = append(out, src+" → "+m.Destination)
	}
	sort.Strings(out)
	return out
}

// parseTimeMs parses the daemon's RFC3339Nano timestamps; the zero time
// ("0001-01-01T00:00:00Z", never started) becomes 0.
func parseTimeMs(s string) int64 {
	if s == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil || t.Unix() <= 0 {
		return 0
	}
	return t.UnixMilli()
}
