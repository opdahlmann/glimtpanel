package collect

import (
	"context"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// SecurityCounts are journald-derived numbers merged into the security section (implemented by internal/journal).
type SecurityCounts struct {
	SSHFailedHour  int
	SSHFailedDay   int
	SSHLast        []protocol.SSHAttempt
	UFWBlocked     int
	Fail2banBanned int
}

// CountsProvider returns the latest counts; implementations must be cheap (cached, refreshed elsewhere).
type CountsProvider interface {
	SecurityCounts(ctx context.Context) SecurityCounts
}
