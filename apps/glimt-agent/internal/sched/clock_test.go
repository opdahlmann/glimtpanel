package sched

import (
	"sync"
	"time"
)

// fakeClock fires tickers and timers only when Advance moves time past
// their due points, in order, one due point at a time.
type fakeClock struct {
	mu      sync.Mutex
	now     time.Time
	tickers []*fakeTicker
	timers  []*fakeTimer
}

type fakeTicker struct {
	clock   *fakeClock
	c       chan time.Time
	period  time.Duration
	next    time.Time
	stopped bool
}

type fakeTimer struct {
	clock   *fakeClock
	c       chan time.Time
	at      time.Time
	fired   bool
	stopped bool
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2025, 9, 1, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) NewTicker(d time.Duration) Ticker {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTicker{clock: c, c: make(chan time.Time, 1), period: d, next: c.now.Add(d)}
	c.tickers = append(c.tickers, t)
	return t
}

func (c *fakeClock) NewTimer(d time.Duration) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{clock: c, c: make(chan time.Time, 1), at: c.now.Add(d)}
	c.timers = append(c.timers, t)
	return t
}

func (t *fakeTicker) C() <-chan time.Time { return t.c }
func (t *fakeTicker) Stop() {
	t.clock.mu.Lock()
	t.stopped = true
	t.clock.mu.Unlock()
}

func (t *fakeTimer) C() <-chan time.Time { return t.c }
func (t *fakeTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	active := !t.fired && !t.stopped
	t.stopped = true
	return active
}

// Advance moves time forward, firing everything due on the way.
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	target := c.now.Add(d)
	for {
		var due time.Time
		found := false
		for _, t := range c.tickers {
			if !t.stopped && !t.next.After(target) && (!found || t.next.Before(due)) {
				due, found = t.next, true
			}
		}
		for _, t := range c.timers {
			if !t.stopped && !t.fired && !t.at.After(target) && (!found || t.at.Before(due)) {
				due, found = t.at, true
			}
		}
		if !found {
			c.now = target
			return
		}
		c.now = due
		for _, t := range c.tickers {
			if !t.stopped && t.next.Equal(due) {
				select {
				case t.c <- due:
				default:
				}
				t.next = t.next.Add(t.period)
			}
		}
		for _, t := range c.timers {
			if !t.stopped && !t.fired && t.at.Equal(due) {
				t.fired = true
				select {
				case t.c <- due:
				default:
				}
			}
		}
	}
}

func (c *fakeClock) counts() (tickers, timers int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, t := range c.tickers {
		if !t.stopped {
			tickers++
		}
	}
	return tickers, len(c.timers)
}
