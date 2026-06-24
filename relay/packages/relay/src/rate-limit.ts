export interface RateLimiterOptions {
  /** Tokens refilled per second. */
  tokensPerSecond: number;
  /** Bucket capacity — the largest burst a key is allowed. */
  burst: number;
  /** Clock returning the current time in seconds (fractional). Overridable for tests. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token-bucket rate limiter keyed by an arbitrary string (typically `connId`).
 * In-memory, single-process. Use `forget(key)` on disconnect to reclaim space.
 */
export class RateLimiter {
  private readonly tokensPerSecond: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: RateLimiterOptions) {
    this.tokensPerSecond = options.tokensPerSecond;
    this.burst = options.burst;
    this.now = options.now ?? (() => Date.now() / 1000);
  }

  /** Consume one token. Returns false when the bucket is empty. */
  allow(key: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.burst, updatedAt: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.tokensPerSecond);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Drop the bucket for a key (e.g. on disconnect). */
  forget(key: string): void {
    this.buckets.delete(key);
  }

  /** Number of live buckets — useful for monitoring. */
  size(): number {
    return this.buckets.size;
  }
}
