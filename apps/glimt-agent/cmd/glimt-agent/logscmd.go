package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/logs"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// printSink writes log lines to stdout and reports when the stream ends.
type printSink struct {
	w    io.Writer
	mu   sync.Mutex
	last time.Time
	end  *protocol.LogEnd
	done chan struct{}
}

func (p *printSink) Send(m protocol.Message) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	switch m := m.(type) {
	case *protocol.Log:
		p.last = time.Now()
		if m.Dropped > 0 {
			fmt.Fprintf(p.w, "... %d lines dropped\n", m.Dropped)
		}
		for _, l := range m.Lines {
			src := l.Unit
			if l.Container != "" {
				src = l.Container
			}
			ts := time.UnixMilli(l.TS).Local().Format("2006-01-02 15:04:05")
			if l.Priority != "" {
				fmt.Fprintf(p.w, "%s %-4s %s: %s\n", ts, l.Priority, src, l.Message)
			} else {
				fmt.Fprintf(p.w, "%s %s: %s\n", ts, src, l.Message)
			}
		}
	case *protocol.LogEnd:
		if p.end == nil {
			p.end = m
			close(p.done)
		}
	}
	return true
}

func (p *printSink) lastLine() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.last
}

// runLogs streams one log source to stdout through the same manager the hub
// uses. Without --follow it stops once the tail has arrived.
func runLogs(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("glimt-agent logs", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var o options
	bindFlags(fs, &o)
	source := fs.String("source", "journal", "journal | auth | kernel | packages | web | firewall | container")
	unit := fs.String("unit", "", "systemd unit to filter on (journal sources)")
	container := fs.String("container", "", "container id or name (source container)")
	priority := fs.String("priority", "", "err | warn | info (journal sources)")
	tail := fs.Int("tail", 20, "lines of history to print first")
	since := fs.Duration("since", 0, "only lines newer than this, e.g. 1h")
	follow := fs.Bool("follow", false, "keep printing new lines until interrupted")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if err := applyEnv(fs, &o, fileLookup()); err != nil {
		fmt.Fprintf(stderr, "glimt-agent logs: %v\n", err)
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
	sink := &printSink{w: stdout, done: make(chan struct{})}
	m := logs.New(d.logsConfig(sink))
	req := protocol.LogStart{StreamID: "cli", Source: *source, Unit: *unit, Container: *container, Priority: *priority, Tail: *tail}
	if *since > 0 {
		req.SinceMs = time.Now().Add(-*since).UnixMilli()
	}
	m.Start(ctx, req)

	if *follow {
		select {
		case <-sink.done:
		case <-ctx.Done():
			m.StopAll()
		}
	} else {
		// Stop once the history has been printed: no line for 750 ms after
		// the first batch, or two seconds without any line at all.
		started := time.Now()
		idle := time.NewTicker(50 * time.Millisecond)
		defer idle.Stop()
	wait:
		for {
			select {
			case <-sink.done:
				break wait
			case <-ctx.Done():
				break wait
			case <-idle.C:
				last := sink.lastLine()
				if (!last.IsZero() && time.Since(last) > 750*time.Millisecond) || (last.IsZero() && time.Since(started) > 2*time.Second) {
					break wait
				}
			}
		}
		m.StopAll()
	}
	<-sink.done
	end := sink.end
	if end.Reason == protocol.LogEndStopped || end.Reason == protocol.LogEndEOF {
		return 0
	}
	fmt.Fprintf(stderr, "glimt-agent logs: stream ended: %s", end.Reason)
	if end.Message != "" {
		fmt.Fprintf(stderr, " (%s)", end.Message)
	}
	fmt.Fprintln(stderr)
	return 1
}
