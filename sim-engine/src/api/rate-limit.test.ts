import { describe, expect, it } from "bun:test";
import { RateLimiter, getClientIp, fingerprintKey } from "./rate-limit";

describe("RateLimiter", () => {
  it("allows up to `limit` requests then blocks the next", () => {
    const lim = new RateLimiter();
    const cfg = { limit: 3, windowMs: 60_000 };
    const now = 1_000;
    expect(lim.check("k", cfg, now).allowed).toBe(true);
    expect(lim.check("k", cfg, now).allowed).toBe(true);
    expect(lim.check("k", cfg, now).allowed).toBe(true);
    const blocked = lim.check("k", cfg, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("tracks remaining tokens accurately on the success path", () => {
    const lim = new RateLimiter();
    const cfg = { limit: 5, windowMs: 60_000 };
    expect(lim.check("k", cfg, 0).remaining).toBe(4);
    expect(lim.check("k", cfg, 0).remaining).toBe(3);
    expect(lim.check("k", cfg, 0).remaining).toBe(2);
  });

  it("uses independent buckets per key", () => {
    const lim = new RateLimiter();
    const cfg = { limit: 1, windowMs: 60_000 };
    expect(lim.check("a", cfg, 0).allowed).toBe(true);
    expect(lim.check("b", cfg, 0).allowed).toBe(true);
    expect(lim.check("a", cfg, 0).allowed).toBe(false);
    expect(lim.check("b", cfg, 0).allowed).toBe(false);
  });

  it("resets after the window elapses", () => {
    const lim = new RateLimiter();
    const cfg = { limit: 1, windowMs: 1_000 };
    expect(lim.check("k", cfg, 0).allowed).toBe(true);
    expect(lim.check("k", cfg, 500).allowed).toBe(false);
    // resetAt = 1000; at t=1000 the window has elapsed (resetAtMs <= now)
    expect(lim.check("k", cfg, 1_000).allowed).toBe(true);
  });

  it("retryAfterSec rounds up to >=1 second", () => {
    const lim = new RateLimiter();
    const cfg = { limit: 1, windowMs: 1_000 };
    lim.check("k", cfg, 0); // consume
    const blocked = lim.check("k", cfg, 999); // 1ms left
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(1);
  });

  it("prune drops expired buckets", () => {
    const lim = new RateLimiter();
    const cfg = { limit: 1, windowMs: 1_000 };
    lim.check("a", cfg, 0);
    lim.check("b", cfg, 0);
    expect(lim.size()).toBe(2);
    expect(lim.prune(2_000)).toBe(2);
    expect(lim.size()).toBe(0);
  });

  it("prune leaves still-active buckets alone", () => {
    const lim = new RateLimiter();
    lim.check("old", { limit: 1, windowMs: 1_000 }, 0);
    lim.check("new", { limit: 1, windowMs: 10_000 }, 5_000);
    expect(lim.prune(6_000)).toBe(1);
    expect(lim.size()).toBe(1);
  });
});

describe("getClientIp", () => {
  it("returns the first hop from X-Forwarded-For", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1, 10.0.0.2" } });
    expect(getClientIp(req)).toBe("1.2.3.4");
  });

  it("falls back to X-Real-IP when XFF missing", () => {
    const req = new Request("http://x", { headers: { "x-real-ip": "5.6.7.8" } });
    expect(getClientIp(req)).toBe("5.6.7.8");
  });

  it("returns the sentinel when no IP headers are present", () => {
    const req = new Request("http://x");
    expect(getClientIp(req)).toBe("unknown");
  });

  it("trims whitespace from the first XFF entry", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "  1.2.3.4 , 10.0.0.1" } });
    expect(getClientIp(req)).toBe("1.2.3.4");
  });
});

describe("fingerprintKey", () => {
  it("returns the last 8 chars of the key", () => {
    expect(fingerprintKey("sk-or-v1-" + "a".repeat(40) + "12345678")).toBe("12345678");
  });
});
