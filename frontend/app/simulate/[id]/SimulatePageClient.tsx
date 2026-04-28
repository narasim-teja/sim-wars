"use client";

import { useMemo, useState } from "react";
import { TopNav, type ViewMode } from "@/components/TopNav";
import { useSimulation } from "@/hooks/useSimulation";
import { computeThreat } from "@/lib/threat";
import { AgentGraph } from "@/components/sim/AgentGraph";
import { NodeDetails } from "@/components/sim/NodeDetails";
import { MetricsBar } from "@/components/sim/MetricsBar";
import { PriceChart } from "@/components/sim/PriceChart";
import { GiniChart } from "@/components/sim/GiniChart";
import { StakingChart } from "@/components/sim/StakingChart";
import { TopHolders } from "@/components/sim/TopHolders";
import { AgentFeed } from "@/components/sim/AgentFeed";
import { ThreatIndicator } from "@/components/sim/ThreatIndicator";
import { SimControls } from "@/components/sim/SimControls";
import { SystemDashboard } from "@/components/sim/SystemDashboard";
import { SectionCard } from "@/components/sim/SectionCard";
import { AGENT_COLORS, AGENT_LABELS, agentTypeFromId } from "@/lib/agent-colors";
import { cn } from "@/lib/utils";

export function SimulatePageClient({ simId }: { simId: string }) {
  const sim = useSimulation(simId);
  const [view, setView] = useState<ViewMode>("split");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const threat = useMemo(() => {
    if (sim.status === "death_spiral")
      return { level: "death_spiral" as const, reasons: [`triggered at tick ${sim.deathSpiralAt}`] };
    return computeThreat(sim.current, sim.series);
  }, [sim.current, sim.series, sim.status, sim.deathSpiralAt]);

  // Step 3 = "Simulate"
  return (
    <div className="flex h-screen min-h-screen flex-col overflow-hidden bg-white">
      <TopNav view={view} onViewChange={setView} step={3} status={sim.status} />

      {/* Sub-bar: sim id + connection + metrics + controls */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-200 bg-white px-6 py-2">
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
          <span>sim</span>
          <span className="text-zinc-900">{simId.slice(0, 12)}</span>
          <span className="text-zinc-300">·</span>
          <span>ws</span>
          <span
            className={cn(
              sim.connection === "open"
                ? "text-emerald-700"
                : sim.connection === "connecting"
                  ? "text-amber-700"
                  : "text-red-700",
            )}
          >
            ● {sim.connection}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <MetricsBar state={sim.current} tick={sim.tick} />
        </div>
        <SimControls simId={simId} status={sim.status as never} />
      </div>

      {/* Main */}
      <div className="grid min-h-0 flex-1 overflow-hidden" style={{
        gridTemplateColumns:
          view === "graph"
            ? "1fr"
            : view === "workbench"
              ? "1fr"
              : "minmax(0, 1fr) 460px",
      }}>
        {/* Graph pane */}
        {view !== "workbench" && (
          <section className="relative overflow-hidden border-r border-zinc-200">
            <AgentGraph state={sim} onSelect={setSelectedAgent} selectedAgentId={selectedAgent} />
            <NodeDetails state={sim} agentId={selectedAgent} onClose={() => setSelectedAgent(null)} />
          </section>
        )}

        {/* Right rail / workbench pane */}
        {view !== "graph" && (
          <aside
            className={cn(
              "thin-scroll flex flex-col gap-4 overflow-y-auto bg-zinc-50/40 p-4",
              view === "workbench" && "mx-auto w-full max-w-4xl",
            )}
          >
            <SectionCard
              number="01"
              title="Live state"
              subtitle="POST /api/sim · streaming via WS"
              status="live"
              rightSlot={<KV label="tick" value={`${sim.tick}/${sim.maxTicks}`} />}
            >
              <div className="grid grid-cols-3 gap-4">
                <KVStat label="Current agents" value={`${Object.keys(sim.agents).length}`} />
                <KVStat label="Expected" value={`${sim.agentCount}`} />
                <KVStat label="Total actions" value={`${sim.feed.length}`} />
              </div>
            </SectionCard>

            <SectionCard
              number="02"
              title="Price · supply concentration"
              subtitle="token price (line) · gini coefficient"
              status={sim.series.length > 0 ? "live" : "ready"}
            >
              <div className="grid gap-4">
                <div>
                  <Label>price</Label>
                  <PriceChart series={sim.series} />
                </div>
                <div>
                  <Label>gini coefficient</Label>
                  <GiniChart series={sim.series} />
                </div>
              </div>
            </SectionCard>

            <SectionCard
              number="03"
              title="Staking + holders"
              subtitle="staked supply (%) · top holders pie"
              status={sim.series.length > 0 ? "live" : "ready"}
            >
              <div className="grid gap-4">
                <div>
                  <Label>staked %</Label>
                  <StakingChart series={sim.series} />
                </div>
                <div>
                  <Label>supply concentration</Label>
                  <TopHolders state={sim.current} />
                </div>
              </div>
            </SectionCard>

            <SectionCard
              number="04"
              title="Agent action feed"
              subtitle={`${sim.feed.length} actions emitted · click an entry to inspect`}
              status="live"
            >
              <div className="-mx-4 -my-4 h-72">
                <AgentFeed feed={sim.feed} onSelect={setSelectedAgent} />
              </div>
            </SectionCard>

            <SectionCard
              number="05"
              title="Adversary roster"
              subtitle={`${sim.agentCount || Object.keys(sim.agents).length} agents · live balances`}
            >
              <RosterList state={sim} onSelect={setSelectedAgent} />
            </SectionCard>

            <ThreatIndicator level={threat.level} reasons={threat.reasons} />
          </aside>
        )}
      </div>

      {/* Bottom system dashboard (terminal) */}
      <SystemDashboard logs={sim.logs} simId={simId} tick={sim.tick} />
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
      {children}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
      <span>{label}</span>
      <span className="text-zinc-900">{value}</span>
    </div>
  );
}

function KVStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">{label}</span>
      <span className="text-[20px] font-semibold tabular-nums text-zinc-900">{value}</span>
    </div>
  );
}

function RosterList({
  state,
  onSelect,
}: {
  state: ReturnType<typeof useSimulation>;
  onSelect: (id: string) => void;
}) {
  const agents = Object.values(state.agents);
  if (agents.length === 0) {
    return (
      <div className="grid h-32 place-items-center font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-400">
        waiting for first tick…
      </div>
    );
  }
  const sorted = [...agents].sort((a, b) => b.balance - a.balance);
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {sorted.map((a) => {
        const t = agentTypeFromId(a.id);
        return (
          <button
            key={a.id}
            onClick={() => onSelect(a.id)}
            className="flex items-center gap-2 rounded border border-zinc-100 bg-white px-3 py-1.5 text-left hover:border-zinc-300"
          >
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ background: AGENT_COLORS[t] }}
            />
            <span className="font-mono text-[12px] font-semibold text-zinc-900">{a.id}</span>
            <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-zinc-500">
              {AGENT_LABELS[t]}
            </span>
            <span className="ml-2 font-mono text-[11px] tabular-nums text-zinc-700">
              {a.balance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          </button>
        );
      })}
    </div>
  );
}
