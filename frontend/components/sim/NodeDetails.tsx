"use client";

import { X } from "lucide-react";
import { AGENT_COLORS, AGENT_LABELS, ACTION_COLORS } from "@/lib/agent-colors";
import type { SimUiState } from "@/hooks/useSimulation";

/**
 * Floating MiroFish-style "Node Details" card. Appears at the top-right of the
 * graph canvas when an agent is selected.
 */
export function NodeDetails({
  state,
  agentId,
  onClose,
}: {
  state: SimUiState;
  agentId: string | null;
  onClose: () => void;
}) {
  if (!agentId) return null;
  const agent = state.agents[agentId];
  if (!agent) return null;
  const recent = state.feed.filter((f) => f.agentId === agentId).slice(0, 6);

  return (
    <div className="absolute right-3 top-3 z-20 w-80 rounded-md border border-zinc-200 bg-white shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
        <div className="flex items-center gap-2 font-mono text-[12px] font-semibold tracking-wide text-zinc-900">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: AGENT_COLORS[agent.type] }}
          />
          Node Details
        </div>
        <div className="flex items-center gap-2">
          <span
            className="rounded-full px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-white"
            style={{ background: AGENT_COLORS[agent.type] }}
          >
            {AGENT_LABELS[agent.type]}
          </span>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid gap-2 px-4 py-3 font-mono text-[11px] text-zinc-700">
        <Row label="Agent" value={agent.id} />
        <Row label="Type" value={AGENT_LABELS[agent.type]} />
        <Row
          label="Balance"
          value={agent.balance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        />
        {agent.lastAction && (
          <>
            <Row label="Last tick" value={`${agent.lastAction.tick}`} />
            <Row
              label="Last action"
              value={agent.lastAction.action.toUpperCase()}
              valueColor={ACTION_COLORS[agent.lastAction.action]}
            />
          </>
        )}
      </div>

      {agent.lastAction?.reasoning && (
        <div className="border-t border-zinc-100 px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">Reasoning</div>
          <p className="mt-1 text-[12px] italic leading-5 text-zinc-700">
            &ldquo;{agent.lastAction.reasoning}&rdquo;
          </p>
        </div>
      )}

      {recent.length > 0 && (
        <div className="border-t border-zinc-100 px-4 py-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
            Recent actions
          </div>
          <div className="flex flex-col gap-1.5">
            {recent.map((f) => (
              <div key={f.id} className="flex items-center gap-2 font-mono text-[11px]">
                <span className="text-zinc-400 tabular-nums">t{f.tick.toString().padStart(2, "0")}</span>
                <span
                  className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white"
                  style={{ background: ACTION_COLORS[f.action] }}
                >
                  {f.action}
                </span>
                {f.amount != null && (
                  <span className="ml-auto tabular-nums text-zinc-600">
                    {f.amount.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-20 shrink-0 text-zinc-500">{label}:</span>
      <span className="font-semibold tabular-nums" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </span>
    </div>
  );
}
