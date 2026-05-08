"use client";

/**
 * BYOK credential store. Single storage abstraction, parameterized by kind so
 * adding a credential is just registering a row in `KINDS` (no parallel
 * `getXxx` / `setXxx` / `clearXxx` ladder per credential).
 *
 * Two kinds today:
 *   - "openrouter" — OpenRouter API key (sk-or-…). Sensitive; supports a
 *      session-only mode in addition to the persistent localStorage default.
 *   - "helius"     — Helius RPC URL or bare API key. Optional, used for
 *      heavy on-chain runs that would throttle on the public devnet RPC.
 *      Less sensitive than the LLM key (it's an RPC, not a billing
 *      credential bound to a payment method) so we don't surface a
 *      session-only mode.
 *
 * Server-side validation is authoritative; the client checks here are loose
 * shape filters to give immediate feedback before the network round-trip.
 */

export type ByokKind = "openrouter" | "helius";

interface KindSpec {
  /** Where the value lives in Storage. */
  storageKey: string;
  /** Optional companion flag — only set when `remember` is meaningful. */
  rememberKey?: string;
  /** Loose shape check. Server validates definitively. */
  validate: (value: string) => boolean;
  /** Mask formatter for UI surfaces (status strip, etc.). */
  mask: (value: string) => string;
}

const KINDS: Record<ByokKind, KindSpec> = {
  openrouter: {
    storageKey: "simwars.byok.openrouter",
    rememberKey: "simwars.byok.remember",
    validate: (s) => /^sk-or-[a-z0-9-]+$/i.test(s.trim()) && s.length <= 200,
    mask: (s) => (s.length <= 8 ? "•••••" : `${s.slice(0, 9)}…${s.slice(-4)}`),
  },
  helius: {
    storageKey: "simwars.byok.helius",
    // No remember toggle — Helius URLs are persistent by default.
    validate: (s) => {
      const v = s.trim();
      if (v.length === 0 || v.length > 300) return false;
      // Bare API key
      if (/^[a-z0-9-]{8,80}$/i.test(v)) return true;
      // Full URL — must be Helius and carry an api-key
      try {
        const u = new URL(v);
        return (
          u.protocol === "https:" &&
          u.host.endsWith(".helius-rpc.com") &&
          u.searchParams.has("api-key")
        );
      } catch {
        return false;
      }
    },
    // Show the host + last 4 of the api-key when it's a URL; mask bare keys.
    mask: (s) => {
      const v = s.trim();
      try {
        const u = new URL(v);
        const k = u.searchParams.get("api-key") ?? "";
        const tail = k.length >= 4 ? k.slice(-4) : "";
        return `${u.host}/?api-key=…${tail}`;
      } catch {
        return v.length <= 8 ? "•••••" : `${v.slice(0, 4)}…${v.slice(-4)}`;
      }
    },
  },
};

export function getStoredCredential(kind: ByokKind): string | null {
  if (typeof window === "undefined") return null;
  const spec = KINDS[kind];
  return (
    window.localStorage.getItem(spec.storageKey) ??
    window.sessionStorage.getItem(spec.storageKey) ??
    null
  );
}

export function setStoredCredential(
  kind: ByokKind,
  value: string,
  opts: { remember?: boolean } = {},
): void {
  if (typeof window === "undefined") return;
  const spec = KINDS[kind];
  const trimmed = value.trim();
  if (!trimmed) {
    clearStoredCredential(kind);
    return;
  }
  // Default to "remember" when the kind doesn't expose the toggle. Only
  // openrouter explicitly distinguishes session vs persistent today.
  const remember = opts.remember ?? !spec.rememberKey;
  // Mutually exclusive write — clear the other store so we don't end up with
  // the same kind sitting in both with different values.
  if (remember) {
    window.localStorage.setItem(spec.storageKey, trimmed);
    window.sessionStorage.removeItem(spec.storageKey);
    if (spec.rememberKey) window.localStorage.setItem(spec.rememberKey, "1");
  } else {
    window.sessionStorage.setItem(spec.storageKey, trimmed);
    window.localStorage.removeItem(spec.storageKey);
    if (spec.rememberKey) window.localStorage.removeItem(spec.rememberKey);
  }
}

export function clearStoredCredential(kind: ByokKind): void {
  if (typeof window === "undefined") return;
  const spec = KINDS[kind];
  window.localStorage.removeItem(spec.storageKey);
  window.sessionStorage.removeItem(spec.storageKey);
  if (spec.rememberKey) window.localStorage.removeItem(spec.rememberKey);
}

export function isRemembered(kind: ByokKind): boolean {
  if (typeof window === "undefined") return false;
  const spec = KINDS[kind];
  if (!spec.rememberKey) {
    // No session-only mode — presence in localStorage is the answer.
    return window.localStorage.getItem(spec.storageKey) !== null;
  }
  return window.localStorage.getItem(spec.rememberKey) === "1";
}

export function validateCredential(kind: ByokKind, value: string): boolean {
  return KINDS[kind].validate(value);
}

export function maskCredential(kind: ByokKind, value: string): string {
  return KINDS[kind].mask(value);
}
