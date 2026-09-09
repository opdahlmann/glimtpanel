// Command collectdump prints what the collect package sees on this machine
// as JSON: Host twice (so rates have a delta), the top processes, services,
// maintenance and security. It is a development aid, not part of the agent.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/collect"
)

func main() {
	top := flag.Int("top", 5, "processes to show")
	wait := flag.Duration("wait", time.Second, "gap between the two samples")
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	sys := collect.NewSystem(collect.Options{Logger: log})
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	out := map[string]any{}
	if _, err := sys.Host(ctx); err != nil {
		out["hostErr1"] = err.Error()
	}
	if _, _, err := sys.Processes(ctx, *top); err != nil {
		out["processesErr1"] = err.Error()
	}
	time.Sleep(*wait)

	host, err := sys.Host(ctx)
	out["host"] = host
	if err != nil {
		out["hostErr"] = err.Error()
	}
	procs, totals, err := sys.Processes(ctx, *top)
	out["processes"], out["processTotals"] = procs, totals
	if err != nil {
		out["processesErr"] = err.Error()
	}
	if svc, err := sys.Services(ctx); err != nil {
		out["servicesErr"] = err.Error()
	} else {
		out["services"] = svc
	}
	if m, err := sys.Maintenance(ctx); err != nil {
		out["maintenanceErr"] = err.Error()
	} else {
		out["maintenance"] = m
	}
	if sec, err := sys.Security(ctx); err != nil {
		out["securityErr"] = err.Error()
	} else {
		out["security"] = sec
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
