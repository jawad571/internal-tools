import { HttpError } from './http.ts';

/** Fixed-window in-memory limiter. Per process, which is fine for abuse damping, not billing. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => Date,
  ) {}

  /** Throws 429 when `key` has exceeded its budget in the current window. */
  hit(key: string): void {
    const now = this.now().getTime();
    if (this.hits.size > 10_000) this.sweep(now);
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > this.max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      throw new HttpError(429, 'rate_limited', 'Too many requests, try again shortly', {
        'Retry-After': String(retryAfter),
      });
    }
  }

  private sweep(now: number) {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}
