package ws

import (
	"math/rand/v2"
	"testing"
	"time"
)

func TestBackoffSequence(t *testing.T) {
	b := NewBackoff(rand.NewPCG(1, 2))
	want := []time.Duration{1, 2, 4, 8, 16, 32, 60, 60, 60}
	var got []time.Duration
	for i := range want {
		d := b.Next()
		base := want[i] * time.Second
		if d < base || d >= base+10*time.Second {
			t.Errorf("attempt %d: %v not in [%v, %v)", i, d, base, base+10*time.Second)
		}
		got = append(got, d)
	}
	b.Reset()
	if d := b.Next(); d < time.Second || d >= 11*time.Second {
		t.Errorf("after reset: %v", d)
	}

	// Same seed gives the same sequence; a different seed (almost surely) differs.
	again := NewBackoff(rand.NewPCG(1, 2))
	for i, d := range got {
		if a := again.Next(); a != d {
			t.Errorf("attempt %d not deterministic: %v vs %v", i, a, d)
		}
	}
	other := NewBackoff(rand.NewPCG(9, 9))
	same := true
	for _, d := range got {
		if other.Next() != d {
			same = false
		}
	}
	if same {
		t.Error("different seeds produced identical jitter")
	}
}

func TestBackoffNoJitter(t *testing.T) {
	b := NewBackoffWith(10*time.Millisecond, 25*time.Millisecond, 0, nil)
	seq := []time.Duration{b.Next(), b.Next(), b.Next(), b.Next()}
	want := []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 25 * time.Millisecond, 25 * time.Millisecond}
	for i := range want {
		if seq[i] != want[i] {
			t.Errorf("seq = %v, want %v", seq, want)
			break
		}
	}
}
