/**
 * Server-side BYOK validators. These are deliberately loose — they protect
 * us from obviously-wrong inputs (so the worker doesn't get a 400 from the
 * provider after we've already spent a worker spawn) but the *real*
 * validation is the upstream provider rejecting the credential.
 *
 * Mirrors `frontend/lib/byok.ts` so client + server agree on what shapes
 * are accepted before the network round-trip. Don't tighten one without
 * tightening the other.
 */

const PUBLIC_DEVNET_RPC_URL = "https://api.devnet.solana.com";

export function isPlausibleOpenRouterKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^sk-or-[a-z0-9-]+$/i.test(value.trim()) && value.length <= 200;
}

/**
 * Accept either a fully-formed Helius URL (with the api-key already in the
 * query string) or a bare API key. Reject anything that smells like a
 * non-Helius URL — we don't want to route the worker through arbitrary RPC
 * endpoints we have no SLA with.
 */
export function isPlausibleHeliusInput(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length === 0 || v.length > 300) return false;
  // Bare API key
  if (/^[a-z0-9-]{8,80}$/i.test(v)) return true;
  // Full URL — must be HTTPS Helius and carry an api-key
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (!url.host.endsWith(".helius-rpc.com")) return false;
  return url.searchParams.has("api-key");
}

/**
 * Normalize the BYOK Helius input into a full RPC URL. Bare API keys get
 * wrapped into the standard Helius devnet URL pattern; full URLs pass
 * through verbatim. Caller is expected to have already validated shape
 * with `isPlausibleHeliusInput`.
 */
export function normalizeHeliusUrl(raw: string): string {
  const v = raw.trim();
  if (v.startsWith("https://")) return v;
  return `https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(v)}`;
}

/**
 * Default RPC for on-chain runs that don't carry a BYOK Helius URL. The
 * public devnet endpoint is rate-limited (~10 req/s) but works for small
 * sims; heavier ones need Helius and should encourage users to BYOK.
 */
export const PUBLIC_DEVNET_RPC = PUBLIC_DEVNET_RPC_URL;
