/**
 * Sliding-window rate limiter for the Fortnox API.
 *
 * Fortnox allows 25 requests per 5 seconds per access token. Exceeding it
 * returns 429 and, repeated, gets an integration throttled harder. The limiter
 * keeps the timestamps of the most recent requests and delays a new one until
 * the window has room, so a burst of voucher-detail calls is spread out
 * instead of tripping the limit and retrying.
 *
 * The clock and the sleep are injectable so the behaviour is unit-testable
 * without waiting real seconds.
 */
export interface RateLimiterOptions {
  readonly maxRequests: number;
  readonly windowMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const FORTNOX_RATE_LIMIT: Pick<RateLimiterOptions, 'maxRequests' | 'windowMs'> = {
  maxRequests: 25,
  windowMs: 5_000,
};

export class SlidingWindowRateLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #stamps: number[] = [];
  /** Serialises acquirers so two callers cannot both see the same free slot. */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    this.#max = options.maxRequests;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Resolves when the caller may send one request. */
  acquire(): Promise<void> {
    const turn = this.#queue.then(() => this.#waitForSlot());
    // A rejected turn must not poison the queue for the next caller.
    this.#queue = turn.catch(() => undefined);
    return turn;
  }

  async #waitForSlot(): Promise<void> {
    for (;;) {
      const now = this.#now();
      while (this.#stamps.length > 0 && (this.#stamps[0] ?? 0) <= now - this.#windowMs) {
        this.#stamps.shift();
      }
      if (this.#stamps.length < this.#max) {
        this.#stamps.push(now);
        return;
      }
      const oldest = this.#stamps[0] ?? now;
      await this.#sleep(Math.max(1, oldest + this.#windowMs - now));
    }
  }
}
