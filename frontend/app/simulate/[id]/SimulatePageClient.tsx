"use client";

import { useState, useMemo } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { StepNav } from "@/components/StepNav";
import { useSimulation } from "@/hooks/useSimulation";
import { computeThreat } from "@/lib/threat";
import { AgentGraph } from "@/components/sim/AgentGraph";
import { AgentSheet } from "@/components/sim/AgentSheet";
import { MetricsBar } from "@/components/sim/MetricsBar";
import { PriceChart } from "@/components/sim/PriceChart";
import { GiniChart } from "@/components/sim/GiniChart";
import { StakingChart } from "@/components/sim/StakingChart";
import { TopHolders } from "@/components/sim/TopHolders";
import { AgentFeed } from "@/components/sim/AgentFeed";
import { SimConsole } from "@/components/sim/SimConsole";
import { ThreatIndicator } from "@/components/sim/ThreatIndicator";
import { SimControls } from "@/components/sim/SimControls";

export function SimulatePageClient({ simId }: { simId: string }) {
  const sim = useSimulation(simId);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const threat = useMemo(() => {
    if (sim.status === "death_spiral") return { level: "death_spiral" as const, reasons: [`triggered at tick ${sim.deathSpiralAt}`] };
    return computeThreat(sim.current, sim.series);
  }, [sim.current, sim.series, sim.status, sim.deathSpiralAt]);

  return (
    <div className="flex h-screen min-h-screen flex-col overflow-hidden">
      <StepNav active="simulate" status={sim.status} />

      <div className="flex items-center justify-between gap-3 border-b border-white/5 bg-black/40 px-6 py-2">
        <div className="flex items-center gap-3 text-[11px] text-zinc-400">
          <span className="font-mono uppercase tracking-[0.25em] text-zinc-500">sim id</span>
          <span className="font-mono text-zinc-200">{simId.slice(0, 8)}…</span>
          <span className="font-mono text-zinc-700">·</span>
          <span className="font-mono uppercase tracking-[0.25em] text-zinc-500">ws</span>
          <span
            className={`font-mono uppercase tracking-widest ${
              sim.connection === "open"
                ? "text-emerald-300"
                : sim.connection === "connecting"
                  ? "text-amber-300"
                  : "text-red-400"
            }`}
          >
            ● {sim.connection}
          </span>
        </div>
        <div className="flex-1">
          <MetricsBar state={sim.current} tick={sim.tick} />
        </div>
        <SimControls simId={simId} status={sim.status as never} />
      </div>

      <div className="grid flex-1 overflow-hidden lg:grid-cols-[1fr_460px]">
        {/* Left: graph */}
        <section className="relative overflow-hidden border-r border-white/5">
          <div className="grid-bg absolute inset-0 opacity-40" />
          <AgentGraph state={sim} onSelect={setSelectedAgent} selectedAgentId={selectedAgent} />
        </section>

        {/* Right: tabs + threat indicator */}
        <aside className="flex flex-col overflow-hidden">
          <Tabs defaultValue="metrics" className="flex flex-1 flex-col overflow-hidden">
            <TabsList className="grid grid-cols-3 rounded-none border-b border-white/5 bg-transparent p-0">
              {["metrics", "feed", "console"].map((v) => (
                <TabsTrigger
                  key={v}
                  value={v}
                  className="rounded-none border-b-2 border-transparent bg-transparent font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500 data-[state=active]:border-cyan-400 data-[state=active]:bg-transparent data-[state=active]:text-cyan-300 data-[state=active]:text-glow-cyan data-[state=active]:shadow-none"
                >
                  {v}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="metrics" className="m-0 flex-1 overflow-y-auto p-3 thin-scroll">
              <div className="flex flex-col gap-3">
                <PriceChart series={sim.series} />
                <GiniChart series={sim.series} />
                <StakingChart series={sim.series} />
                <TopHolders state={sim.current} />
              </div>
            </TabsContent>

            <TabsContent value="feed" className="m-0 flex-1 overflow-hidden">
              <AgentFeed feed={sim.feed} onSelect={setSelectedAgent} />
            </TabsContent>

            <TabsContent value="console" className="m-0 flex-1 overflow-hidden">
              <SimConsole logs={sim.logs} />
            </TabsContent>
          </Tabs>

          <div className="border-t border-white/5 p-3">
            <ThreatIndicator level={threat.level} reasons={threat.reasons} />
          </div>
        </aside>
      </div>

      <AgentSheet state={sim} agentId={selectedAgent} onClose={() => setSelectedAgent(null)} />
    </div>
  );
}
