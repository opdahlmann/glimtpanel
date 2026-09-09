package sched

import (
	"context"
	"sync"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// Periodic is refreshed on the maintenance tick and, when stale, at the
// start of a connection (journal.Counter, MaintenanceCache).
type Periodic interface {
	Refresh(ctx context.Context) error
	RefreshedAt() time.Time
}

// MaintenanceCache keeps the last maintenance section. It is created once
// per process so reconnects do not re-run the package checks.
type MaintenanceCache struct {
	sys System
	now func() time.Time

	mu    sync.Mutex
	value *protocol.Maintenance
	at    time.Time
	err   error
}

// NewMaintenanceCache builds an empty cache over sys; now may be nil.
func NewMaintenanceCache(sys System, now func() time.Time) *MaintenanceCache {
	if now == nil {
		now = time.Now
	}
	return &MaintenanceCache{sys: sys, now: now}
}

// Refresh runs System.Maintenance and stores the result. On error the
// previous value is kept.
func (m *MaintenanceCache) Refresh(ctx context.Context) error {
	v, err := m.sys.Maintenance(ctx)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.at = m.now()
	m.err = err
	if err == nil {
		m.value = v
	}
	return err
}

// RefreshedAt returns when Refresh last ran (zero before the first).
func (m *MaintenanceCache) RefreshedAt() time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.at
}

// Value returns the cached section, nil before the first successful Refresh.
func (m *MaintenanceCache) Value() *protocol.Maintenance {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.value
}
