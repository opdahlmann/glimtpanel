package ws

import (
	"math/rand/v2"
	"time"
)

// Backoff produces reconnect delays: Min doubling up to Max, plus a random
// 0–Jitter addition so a fleet of agents does not hit the hub in lockstep.
type Backoff struct {
	Min, Max, Jitter time.Duration
	rnd              *rand.Rand
	attempt          int
}

// NewBackoff returns the production schedule 1 s → 60 s with 0–10 s jitter.
// src may be nil for an unpredictable seed.
func NewBackoff(src rand.Source) *Backoff {
	return NewBackoffWith(time.Second, 60*time.Second, 10*time.Second, src)
}

// NewBackoffWith returns a custom schedule.
func NewBackoffWith(min, max, jitter time.Duration, src rand.Source) *Backoff {
	if src == nil {
		src = rand.NewPCG(rand.Uint64(), rand.Uint64())
	}
	return &Backoff{Min: min, Max: max, Jitter: jitter, rnd: rand.New(src)}
}

// Next returns the delay before the next attempt and advances the schedule.
func (b *Backoff) Next() time.Duration {
	base := b.Min << uint(b.attempt)
	if base > b.Max || base <= 0 {
		base = b.Max
	} else if base < b.Max {
		b.attempt++
	}
	var jitter time.Duration
	if b.Jitter > 0 {
		jitter = time.Duration(b.rnd.Int64N(int64(b.Jitter)))
	}
	return base + jitter
}

// Reset starts over from Min after a successful connection.
func (b *Backoff) Reset() { b.attempt = 0 }
