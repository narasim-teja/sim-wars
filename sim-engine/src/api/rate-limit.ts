/**
 * Fixed-window rate limiter — N requests per windowMs per bucket key.
 *
 * Each `check(key)` consumes a token from the bucket and returns whether
 * the request is allowed plus when the window resets. Buckets are created
 * lazily on first hit. `prune()` drops expired buckets so the map can't
 * grow without bound on a long-running process.
 *
 * In-memory only — App Runner restarts reset the windows. That's fine for
 * the abuse-prevention use case (sliding back to 0 after a restart is the
 * same shape as moving to the next window).
 */
export interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Tokens left in the current window after this call. */
  remaining: number;
  /** Unix-ms timestamp when the current window resets. */
  resetAtMs: number;
  /** Whole seconds until reset; 0 when allowed. */
  retryAfterSec: number;
  /** The configured limit (echoed for response headers). */
  limit: number;
}

interface Bucket {
  tokens: number;
  resetAtMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  check(key: string, cfg: RateLimitConfig, now = Date.now()): RateLimitDecision {
    let b = this.buckets.get(key);
    if (!b || b.resetAtMs <= now) {
      b = { tokens: cfg.limit, resetAtMs: now + cfg.windowMs };
      this.buckets.set(key, b);
    }
    if (b.tokens <= 0) {
      return {
        allowed: false,
        remaining: 0,
        resetAtMs: b.resetAtMs,
        retryAfterSec: Math.max(1, Math.ceil((b.resetAtMs - now) / 1000)),
        limit: cfg.limit,
      };
    }
    b.tokens -= 1;
    return {
      allowed: true,
      remaining: b.tokens,
      resetAtMs: b.resetAtMs,
      retryAfterSec: 0,
      limit: cfg.limit,
    };
  }

  /**
   * Drop buckets whose window has already elapsed. Call periodically to
   * cap memory growth — one stale bucket per unique key seen since the
   * last prune.
   */
  prune(now = Date.now()): number {
    let removed = 0;
    for (const [k, b] of this.buckets) {
      if (b.resetAtMs <= now) {
        this.buckets.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  /** Test helper — wipe all state. */
  reset(): void {
    this.buckets.clear();
  }

  /** Test helper — current bucket count. */
  size(): number {
    return this.buckets.size;
  }
}

/** Process-wide singleton used by the API server. */
export const apiRateLimiter = new RateLimiter();

/**
 * Take the first IP from `X-Forwarded-For` (the canonical client). Falls
 * back to `X-Real-IP` and then a sentinel so a missing header still
 * produces a usable bucket key (all anonymous requests share one bucket
 * — strict, but right for the abuse case).
 */
export function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

/**
 * Fingerprint a BYOK key for the bucket map. We never want the full key
 * sitting in the limiter map — last 8 chars is enough to disambiguate
 * keys without persisting any privileged material. A second user with a
 * coincidentally-matching last-8 would share a bucket; that's an
 * acceptable false-positive at this layer (real auth would solve it).
 */
export function fingerprintKey(byokKey: string): string {
  return byokKey.slice(-8);
}
