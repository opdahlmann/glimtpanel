package sched

import "time"

// Clock is the time source; tests inject a fake one.
type Clock interface {
	Now() time.Time
	NewTicker(d time.Duration) Ticker
	NewTimer(d time.Duration) Timer
}

// Ticker mirrors time.Ticker.
type Ticker interface {
	C() <-chan time.Time
	Stop()
}

// Timer mirrors time.Timer.
type Timer interface {
	C() <-chan time.Time
	Stop() bool
}

// RealClock uses package time.
type RealClock struct{}

func (RealClock) Now() time.Time                   { return time.Now() }
func (RealClock) NewTicker(d time.Duration) Ticker { return realTicker{time.NewTicker(d)} }
func (RealClock) NewTimer(d time.Duration) Timer   { return realTimer{time.NewTimer(d)} }
func (t realTicker) C() <-chan time.Time           { return t.t.C }
func (t realTicker) Stop()                         { t.t.Stop() }
func (t realTimer) C() <-chan time.Time            { return t.t.C }
func (t realTimer) Stop() bool                     { return t.t.Stop() }

type realTicker struct{ t *time.Ticker }
type realTimer struct{ t *time.Timer }
