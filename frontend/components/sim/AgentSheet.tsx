"use client";

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AGENT_COLORS, AGENT_LABELS, ACTION_COLORS } from "@/lib/agent-colors";
import type { SimUiState } from "@/hooks/useSimulation";

export function AgentSheet({
  state,
  agentId,
  onClose,
}: {
  state: SimUiState;
  agentId: string | null;
  onClose: () => void;
}) {
  const open = !!agentId;
  const agent = agentId ? state.agents[agentId] : null;
  const recent = state.feed.filter((f) => f.agentId === agentId).slice(0, 20);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-[420px] border-l border-white/10 bg-zinc-950/95 backdrop-blur-xl !sm:max-w-[420px]">
        <SheetHeader className="space-y-2">
          {agent && (
            <>
              <div className="flex items-center gap-3">
                <span
                  className="h-3 w-3 rounded-full"
                  style={{
                    background: AGENT_COLORS[agent.type],
                    boxShadow: `0 0 12px ${AGENT_COLORS[agent.type]}`,
                  }}
                />
                <SheetTitle className="font-mono text-lg tracking-wide">{agent.id}</SheetTitle>
              </div>
              <SheetDescription className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
                {AGENT_LABELS[agent.type]}
              </SheetDescription>
            </>
          )}
        </SheetHeader>

        {agent && (
          <div className="mt-5 flex flex-col gap-5 px-4">
            <section className="space-y-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">balance</div>
              <div className="font-mono text-2xl font-semibold text-cyan-300 text-glow-cyan tabular-nums">
                {agent.balance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-600">tokens (top-holder snapshot)</div>
            </section>

            {agent.lastAction && (
              <section className="space-y-2">
                <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">most recent action</div>
                <div className="rounded border border-white/5 bg-black/40 p-3">
                  <div className="flex items-center justify-between">
                    <Badge
                      variant="outline"
                      className="font-mono text-[10px] uppercase tracking-widest"
                      style={{
                        borderColor: ACTION_COLORS[agent.lastAction.action] + "60",
                        color: ACTION_COLORS[agent.lastAction.action],
                      }}
                    >
                      {agent.lastAction.action}
                    </Badge>
                    <span className="font-mono text-[10px] text-zinc-500">tick {agent.lastAction.tick}</span>
                  </div>
                  {agent.lastAction.amount != null && (
                    <div className="mt-1 font-mono text-sm text-zinc-300 tabular-nums">
                      {agent.lastAction.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </div>
                  )}
                  {agent.lastAction.reasoning && (
                    <p className="mt-2 text-xs italic text-zinc-400">&ldquo;{agent.lastAction.reasoning}&rdquo;</p>
                  )}
                  {agent.lastAction.threatAssessment && agent.lastAction.threatAssessment !== "none" && (
                    <p className="mt-2 text-[11px] text-amber-300">
                      ⚠ threat: {agent.lastAction.threatAssessment}
                    </p>
                  )}
                </div>
              </section>
            )}

            <section className="space-y-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">action history (last 20)</div>
              <ScrollArea className="h-72 rounded border border-white/5 bg-black/30">
                <div className="thin-scroll p-2">
                  {recent.length === 0 ? (
                    <div className="p-3 text-center font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                      no actions yet
                    </div>
                  ) : (
                    recent.map((f) => (
                      <div key={f.id} className="border-b border-white/5 px-2 py-1.5 last:border-0">
                        <div className="flex items-center justify-between">
                          <Badge
                            variant="outline"
                            className="font-mono text-[9px] uppercase tracking-widest"
                            style={{
                              borderColor: ACTION_COLORS[f.action] + "60",
                              color: ACTION_COLORS[f.action],
                            }}
                          >
                            {f.action}
                          </Badge>
                          <span className="font-mono text-[10px] text-zinc-500">t{f.tick}</span>
                        </div>
                        {f.amount != null && (
                          <div className="font-mono text-[11px] text-zinc-300 tabular-nums">
                            {f.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </div>
                        )}
                        <p className="text-[10px] italic text-zinc-500">&ldquo;{f.reasoning}&rdquo;</p>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
