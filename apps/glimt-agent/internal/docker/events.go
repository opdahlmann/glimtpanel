package docker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"time"
)

// Events follows GET /events for container events until ctx ends or the
// stream breaks. Every event invalidates that container's inspect cache
// and then calls cb; the caller debounces.
func (e *Engine) Events(ctx context.Context, cb func()) error {
	if err := e.ensureVersion(ctx); err != nil {
		return err
	}
	filters, _ := json.Marshal(map[string][]string{"type": {"container"}})
	resp, err := e.c.do(ctx, "/events", url.Values{"filters": {string(filters)}}, true)
	if err != nil {
		e.reachable.Store(false)
		return err
	}
	defer resp.Body.Close()
	e.reachable.Store(true)
	dec := json.NewDecoder(resp.Body)
	for {
		var ev event
		if err := dec.Decode(&ev); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, io.EOF) {
				return io.ErrUnexpectedEOF
			}
			return err
		}
		if ev.Actor.ID != "" {
			e.invalidate(ev.Actor.ID)
		}
		if cb != nil {
			cb()
		}
	}
}

// WatchEvents keeps Events running until ctx ends, reconnecting with a
// backoff of 1 s doubling to 30 s. Failures are logged once per hour.
func (e *Engine) WatchEvents(ctx context.Context, cb func()) {
	wait := time.Second
	var lastLog time.Time
	for {
		err := e.Events(ctx, cb)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			if now := e.now(); now.Sub(lastLog) >= time.Hour {
				lastLog = now
				e.log.Warn("docker event stream ended; will retry", "err", err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if wait < 30*time.Second {
			wait *= 2
		}
	}
}
