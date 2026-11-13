package server

import (
	"math"
	"sync"
	"time"
)

// flowLimiter caps flow creation in one API process. The public Nginx entry
// point also enforces per-source and global limits before traffic reaches it.
type flowLimiter struct {
	mu     sync.Mutex
	rate   float64
	burst  float64
	tokens float64
	last   time.Time
}

func newFlowLimiter(rate float64, burst int) *flowLimiter {
	return &flowLimiter{rate: rate, burst: float64(burst), tokens: float64(burst)}
}

func (l *flowLimiter) allow(now time.Time) (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.last.IsZero() {
		l.tokens = math.Min(l.burst, l.tokens+math.Max(0, now.Sub(l.last).Seconds())*l.rate)
	}
	l.last = now
	if l.tokens < 1 {
		return false, int(math.Max(1, math.Ceil((1-l.tokens)/l.rate)))
	}
	l.tokens--
	return true, 0
}
