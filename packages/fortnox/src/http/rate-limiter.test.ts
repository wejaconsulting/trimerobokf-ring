import { describe, expect, it } from 'vitest';
import { SlidingWindowRateLimiter } from './rate-limiter.js';

/** A fake clock the limiter's sleep advances, so the test never waits. */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    sleeps,
  };
}

describe('SlidingWindowRateLimiter', () => {
  it('lets a burst up to the limit through without sleeping', async () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowRateLimiter({ maxRequests: 3, windowMs: 1000, ...clock });
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(clock.sleeps).toEqual([]);
  });

  it('delays the request that would exceed the window until the oldest one expires', async () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowRateLimiter({ maxRequests: 2, windowMs: 1000, ...clock });
    await limiter.acquire(); // t=0
    clock.advance(300);
    await limiter.acquire(); // t=300
    clock.advance(100);
    await limiter.acquire(); // needs t>=1000 -> sleeps 600
    expect(clock.sleeps).toEqual([600]);
    expect(clock.now()).toBe(1000);
  });

  it('serialises concurrent acquirers so they cannot share a slot', async () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowRateLimiter({ maxRequests: 1, windowMs: 100, ...clock });
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    // Three requests through a one-per-100ms window: two waits.
    expect(clock.sleeps).toEqual([100, 100]);
  });
});
