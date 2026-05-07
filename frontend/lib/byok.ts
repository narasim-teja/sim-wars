"use client";

/**
 * BYOK key storage. Two modes:
 *   - "remember": persisted in localStorage; re-used across page loads.
 *   - "session": held in sessionStorage; cleared on tab close.
 *
 * Key shape is validated client-side before sending; the server validates
 * again. Format check is loose because OpenRouter's key format may evolve.
 */

const LS_KEY = "simwars.byok.openrouter";
const LS_REMEMBER = "simwars.byok.remember";

export function getStoredKey(): string | null {
  if (typeof window === "undefined") return null;
  const persisted = window.localStorage.getItem(LS_KEY);
  if (persisted) return persisted;
  const session = window.sessionStorage.getItem(LS_KEY);
  return session ?? null;
}

export function setStoredKey(key: string, remember: boolean): void {
  if (typeof window === "undefined") return;
  const trimmed = key.trim();
  if (!trimmed) {
    clearStoredKey();
    return;
  }
  if (remember) {
    window.localStorage.setItem(LS_KEY, trimmed);
    window.localStorage.setItem(LS_REMEMBER, "1");
    window.sessionStorage.removeItem(LS_KEY);
  } else {
    window.sessionStorage.setItem(LS_KEY, trimmed);
    window.localStorage.removeItem(LS_KEY);
    window.localStorage.removeItem(LS_REMEMBER);
  }
}

export function clearStoredKey(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(LS_KEY);
  window.localStorage.removeItem(LS_REMEMBER);
  window.sessionStorage.removeItem(LS_KEY);
}

export function isRemembered(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(LS_REMEMBER) === "1";
}

/** Loose check — exact server validation lives in api/server.ts. */
export function looksLikeOpenRouterKey(s: string): boolean {
  return /^sk-or-[a-z0-9-]+$/i.test(s.trim()) && s.length <= 200;
}

/** Mask all but last 4 for display, e.g. "sk-or-v1-…a3f7". */
export function maskKey(k: string): string {
  if (!k || k.length <= 8) return "•••••";
  return `${k.slice(0, 9)}…${k.slice(-4)}`;
}
