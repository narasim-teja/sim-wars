import type { StatusSnapshot } from "./types";

/**
 * In production we serve the API and the frontend from the same origin
 * (Caddy fronts both inside the container), so default to relative URLs.
 * Override with NEXT_PUBLIC_SIM_API for local dev pointing at a separate
 * sim-engine on :8787.
 */
export const API_BASE = process.env.NEXT_PUBLIC_SIM_API ?? "";

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
  /**
   * Dotted paths the user grounded in the source OR explicitly edited in the
   * config form (e.g. ["staking.baseAPY"]). Drives mode-aware deployment:
   * programs whose section is absent here are skipped on-chain. Omit for
   * preset scenarios — they get the legacy "deploy everything" behavior.
   */
  extractedFields?: string[];
  tickConfig: { intervalMs: number; maxTicks: number };
  onChain?: boolean;
  /**
   * Bring-your-own OpenRouter key. Forwarded to the spawned worker via env;
   * the API server never persists or logs it. Required when the deployment
   * sets `SIM_REQUIRE_BYOK=1` (production).
   */
  byokOpenRouterKey?: string;
}

export interface DemoCard {
  simId: string;
  name: string;
  description: string;
  status: string;
  totalTicks: number;
  resilienceScore: number | null;
  resilienceGrade: string | null;
  deathSpiralDetected: boolean;
}

export async function listDemos(): Promise<DemoCard[]> {
  const r = await fetch(`${API_BASE}/api/demos`);
  if (!r.ok) throw new Error(`GET /api/demos failed: ${r.status}`);
  const body = (await r.json()) as { demos: DemoCard[] };
  return body.demos;
}

/** Mirror of sim-engine `DeploymentPlan` — returned by `POST /api/sim`. */
export interface DeploymentPlanResponse {
  symbols: { base: string; quote: string };
  programs: { tokenMint: true; ammDex: true; staking: boolean; governance: boolean };
  skipped: {
    program: "staking" | "governance";
    reason: string;
    enableHint: string;
  }[];
  blockers: string[];
  warnings: string[];
  liquidSeedAllocation: string | null;
  requiredBaseTokens: number;
}

export interface CreateSimResponse {
  simId: string;
  status: string;
  agentCount: number;
  deploymentPlan: DeploymentPlanResponse;
}

export async function createSim(body: CreateSimBody): Promise<CreateSimResponse> {
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
