import type { StatusSnapshot } from "./types";

export const API_BASE =
  process.env.NEXT_PUBLIC_SIM_API ?? "http://localhost:8787";

/**
 * Roster preset matching the backend `RosterPreset` type. Drives the
 * server-side roster expander when the client sends `agentCount` instead
 * of an explicit `agents[]` list.
 */
export type RosterPreset = "luna" | "crv" | "balanced" | "stress" | "lockup_resilience";

export interface CreateSimBody {
  config: unknown;
  /**
   * Explicit roster — full control. When omitted, the server expands a
   * deterministic roster sized by `agentCount` using `rosterPreset`.
   * Frontend sends this only when the user picked a hand-written preset
   * at its native size; for any other size we let the expander run.
   */
  agents?: unknown[];
  /** When `agents` is omitted, expand a roster of this size. Backend cap = MAX_AGENTS (5000 default). */
  agentCount?: number;
  /** Archetype mix used by the expander. */
  rosterPreset?: RosterPreset;
  extractionMeta?: {
    protocolName?: string;
    protocolKind?: string;
    tokenSymbol?: string;
    quoteSymbol?: string;
  };
  tickConfig: { intervalMs: number; maxTicks: number };
  onChain?: boolean;
}

export async function createSim(body: CreateSimBody): Promise<{ simId: string; status: string; agentCount: number }> {
  const r = await fetch(`${API_BASE}/api/sim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`POST /api/sim failed (${r.status}): ${text.slice(0, 240)}`);
  }
  return r.json();
}

export async function getStatus(simId: string): Promise<StatusSnapshot> {
  const r = await fetch(`${API_BASE}/api/sim/${simId}`);
  if (!r.ok) throw new Error(`GET /api/sim/${simId} failed: ${r.status}`);
  return r.json();
}

export async function controlSim(
  simId: string,
  cmd: "pause" | "resume" | "abort",
): Promise<{ ok: boolean }> {
  const r = await fetch(`${API_BASE}/api/sim/${simId}/${cmd}`, { method: "POST" });
  if (!r.ok) throw new Error(`POST /api/sim/${simId}/${cmd} failed: ${r.status}`);
  return r.json();
}

export async function draftScenario(goal: string): Promise<{ config: unknown; rationale: Record<string, string> }> {
  const r = await fetch(`${API_BASE}/api/scenarios/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  if (!r.ok) throw new Error(`POST /api/scenarios/draft failed: ${r.status}`);
  return r.json();
}
