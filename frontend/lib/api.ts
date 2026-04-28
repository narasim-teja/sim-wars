import type { StatusSnapshot } from "./types";

export const API_BASE =
  process.env.NEXT_PUBLIC_SIM_API ?? "http://localhost:8787";

export interface CreateSimBody {
  config: unknown;
  agents: unknown[];
  tickConfig: { intervalMs: number; maxTicks: number };
  onChain?: boolean;
}

export async function createSim(body: CreateSimBody): Promise<{ simId: string; status: string }> {
  const r = await fetch(`${API_BASE}/api/sim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST /api/sim failed: ${r.status}`);
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
