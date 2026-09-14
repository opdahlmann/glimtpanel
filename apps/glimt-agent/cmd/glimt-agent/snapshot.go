package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/sched"
)

type discardSink struct{}

func (discardSink) Send(protocol.Message) bool { return true }

// runOnce prints one snapshot or stream message as pretty JSON, without a
// hub: prime the rate counters, wait, measure.
func runOnce(name string, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("glimt-agent "+name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	var o options
	bindFlags(fs, &o)
	wait := fs.Duration("wait", time.Second, "time between the two samples the rates need")
	top := fs.Int("top", 40, "processes to include (stream)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if err := applyEnv(fs, &o, fileLookup()); err != nil {
		fmt.Fprintf(stderr, "glimt-agent %s: %v\n", name, err)
		return 2
	}
	log, err := newLogger(o.logLevel, stderr)
	if err != nil {
		fmt.Fprintf(stderr, "glimt-agent: %v\n", err)
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	d := buildDeps(ctx, &o, log)
	s := sched.New(d.schedConfig(discardSink{}, 0, 0))
	s.Prime(ctx)
	if name == "stream" {
		_, _, _ = d.system.Processes(ctx, *top)
	} else if d.maint != nil {
		if err := d.maint.Refresh(ctx); err != nil {
			log.Warn("maintenance check failed", "err", err)
		}
		if err := d.counter.Refresh(ctx); err != nil {
			log.Warn("journal counts failed", "err", err)
		}
	}
	select {
	case <-ctx.Done():
		return 1
	case <-time.After(*wait):
	}
	var msg protocol.Message
	if name == "stream" {
		msg = s.Stream(ctx, *top)
	} else {
		msg = s.Snapshot(ctx)
	}
	return printJSON(stdout, stderr, msg)
}

func printJSON(stdout, stderr io.Writer, msg protocol.Message) int {
	data, err := protocol.Encode(msg)
	if err != nil {
		fmt.Fprintf(stderr, "glimt-agent: %v\n", err)
		return 1
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, data, "", "  "); err != nil {
		fmt.Fprintf(stderr, "glimt-agent: %v\n", err)
		return 1
	}
	pretty.WriteByte('\n')
	if _, err := stdout.Write(pretty.Bytes()); err != nil && !errors.Is(err, os.ErrClosed) {
		return 1
	}
	return 0
}
