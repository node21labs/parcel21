import { describe, expect, test } from "vite-plus/test";
import { RateLimiter } from "../src/rate-limit.ts";

describe("RateLimiter", () => {
  test("allows up to burst capacity immediately, then rejects", () => {
    let now = 0;
    const rl = new RateLimiter({ tokensPerSecond: 1, burst: 3, now: () => now });
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(false);
  });

  test("refills at tokensPerSecond", () => {
    let now = 0;
    const rl = new RateLimiter({ tokensPerSecond: 2, burst: 2, now: () => now });
    // Drain the bucket.
    rl.allow("a");
    rl.allow("a");
    expect(rl.allow("a")).toBe(false);

    // Half a second later: +1 token.
    now = 0.5;
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(false);
  });

  test("caps tokens at burst even after long idle", () => {
    let now = 0;
    const rl = new RateLimiter({ tokensPerSecond: 1, burst: 3, now: () => now });
    rl.allow("a");
    now = 1000; // idle a long time
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(false); // still only burst tokens
  });

  test("per-key isolation", () => {
    let now = 0;
    const rl = new RateLimiter({ tokensPerSecond: 1, burst: 1, now: () => now });
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(false);
    expect(rl.allow("b")).toBe(true); // b has its own bucket
  });

  test("forget() drops a key's bucket", () => {
    let now = 0;
    const rl = new RateLimiter({ tokensPerSecond: 1, burst: 1, now: () => now });
    rl.allow("a");
    expect(rl.size()).toBe(1);
    rl.forget("a");
    expect(rl.size()).toBe(0);
  });
});
