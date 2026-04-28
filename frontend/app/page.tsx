"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StepNav } from "@/components/StepNav";
import { SCENARIO_PRESETS } from "@/lib/scenarios";
import { createSim } from "@/lib/api";
import { AGENT_COLORS, AGENT_LABELS } from "@/lib/agent-colors";
import { agentTypeFromId } from "@/lib/agent-colors";
import { cn } from "@/lib/utils";
import { Play, Loader2, Zap, Skull, ShieldAlert } from "lucide-react";

type ScenarioId = (typeof SCENARIO_PRESETS)[number]["id"];

export default function Home() {
  const router = useRouter();
  const [selected, setSelected] = useState<ScenarioId>("luna-20");
  const [maxTicks, setMaxTicks] = useState(50);
  const [tickInterval, setTickInterval] = useState(0);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = SCENARIO_PRESETS.find((s) => s.id === selected)!;

  async function launch() {
    setError(null);
    setLaunching(true);
    try {
      const body = {
        config: preset.payload.config,
        agents: preset.payload.agents,
        tickConfig: { intervalMs: tickInterval, maxTicks },
        onChain: false,
      };
      const { simId } = await createSim(body);
      router.push(`/simulate/${simId}`);
    } catch (e) {
      setError((e as Error).message);
      setLaunching(false);
    }
  }

  const agentTypes = new Map<string, number>();
  for (const a of preset.payload.agents) {
    const t = agentTypeFromId(a.id);
    agentTypes.set(t, (agentTypes.get(t) ?? 0) + 1);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <StepNav active="configure" />

      <main className="grid-bg relative flex-1 overflow-hidden">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-12">
          {/* Hero */}
          <section className="flex flex-col items-start gap-3">
            <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-300 border-cyan-400/40 bg-cyan-400/5">
              <Zap className="mr-1 h-3 w-3" /> phase 2 · live
            </Badge>
            <h1 className="font-mono text-5xl font-bold leading-tight tracking-tight md:text-6xl">
              <span className="text-glow-cyan text-cyan-300">deploy.</span>{" "}
              <span className="text-zinc-300">unleash.</span>{" "}
              <span className="text-glow-red text-red-400">survive.</span>
            </h1>
            <p className="max-w-2xl text-sm text-zinc-400">
              Pick a scenario. Twenty LLM-powered adversaries hit your token economy on Solana devnet.
              Whales front-run. Farmers cascade. Governance attackers collude. Watch your design either survive — or speedrun a death spiral.
            </p>
          </section>

          {/* Scenario picker */}
          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-xs uppercase tracking-[0.25em] text-zinc-500">01 · Select scenario</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {SCENARIO_PRESETS.map((s) => {
                const active = s.id === selected;
                return (
                  <Card
                    key={s.id}
                    onClick={() => {
                      setSelected(s.id);
                      setMaxTicks(s.defaultMaxTicks);
                    }}
                    className={cn(
                      "panel relative cursor-pointer overflow-hidden p-5 transition-all hover:border-cyan-400/40",
                      active && "border-cyan-400/60 glow-cyan",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-300/80">
                          {s.id}
                        </div>
                        <div className="mt-1 text-lg font-semibold text-zinc-100">{s.label}</div>
                      </div>
                      <Badge variant="outline" className="border-zinc-700 bg-zinc-950/40 font-mono text-[10px] uppercase tracking-widest">
                        {s.payload.agents.length} agents
                      </Badge>
                    </div>
                    <p className="mt-3 text-xs text-zinc-400">{s.description}</p>
                  </Card>
                );
              })}
            </div>
          </section>

          {/* Roster preview */}
          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-xs uppercase tracking-[0.25em] text-zinc-500">
              02 · Adversary roster — {preset.payload.agents.length} agents
            </h2>
            <Card className="panel p-4">
              <div className="flex flex-wrap gap-2">
                {preset.payload.agents.map((a) => {
                  const t = agentTypeFromId(a.id);
                  return (
                    <div
                      key={a.id}
                      className="flex items-center gap-2 rounded-full border border-white/5 bg-black/30 px-2.5 py-1"
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: AGENT_COLORS[t], boxShadow: `0 0 8px ${AGENT_COLORS[t]}` }}
                      />
                      <span className="font-mono text-[11px] text-zinc-200">{a.id}</span>
                      <span className="font-mono text-[10px] text-zinc-500">{AGENT_LABELS[t]}</span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 flex flex-wrap gap-3 border-t border-white/5 pt-3 text-[11px] text-zinc-500">
                {[...agentTypes.entries()].map(([type, n]) => (
                  <div key={type} className="flex items-center gap-1.5">
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: AGENT_COLORS[type as keyof typeof AGENT_COLORS] }}
                    />
                    <span className="font-mono">{n}× {AGENT_LABELS[type as keyof typeof AGENT_LABELS]}</span>
                  </div>
                ))}
              </div>
            </Card>
          </section>

          {/* Tick params */}
          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-xs uppercase tracking-[0.25em] text-zinc-500">03 · Tick parameters</h2>
            <Card className="panel grid gap-4 p-5 md:grid-cols-2">
              <NumberField
                label="MAX TICKS"
                hint="how long the sim runs (each tick = one LLM round)"
                value={maxTicks}
                onChange={setMaxTicks}
                min={1}
                max={500}
              />
              <NumberField
                label="TICK INTERVAL (ms)"
                hint="0 = run as fast as the LLM responds"
                value={tickInterval}
                onChange={setTickInterval}
                min={0}
                max={20000}
                step={500}
              />
            </Card>
          </section>

          {/* Launch */}
          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-xs uppercase tracking-[0.25em] text-zinc-500">04 · Launch</h2>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1 text-sm text-zinc-400">
                <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-zinc-500">
                  <ShieldAlert className="h-3 w-3" /> warning
                </div>
                <p className="max-w-xl">
                  This will spawn {preset.payload.agents.length} agents and hit{" "}
                  <span className="font-mono text-zinc-200">/api/sim</span> on the local engine.
                  If the engine isn&apos;t running, start it with{" "}
                  <span className="font-mono text-cyan-300">bun run sim-engine/src/api/server.ts</span>.
                </p>
              </div>
              <Button
                size="lg"
                onClick={launch}
                disabled={launching}
                className="group relative h-14 min-w-[220px] overflow-hidden bg-cyan-500 font-mono text-sm uppercase tracking-[0.25em] text-black hover:bg-cyan-400"
              >
                {launching ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> launching
                  </>
                ) : (
                  <>
                    <Play className="mr-2 h-4 w-4 fill-current" /> deploy &amp; simulate
                  </>
                )}
                <span className="pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity group-hover:opacity-100" style={{ background: "radial-gradient(ellipse at center, rgba(34,211,238,0.4), transparent 60%)" }} />
              </Button>
            </div>
            {error && (
              <div className="flex items-center gap-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-300">
                <Skull className="h-3 w-3" /> {error}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function NumberField({
  label, hint, value, onChange, min, max, step,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        min={min}
        max={max}
        step={step}
        className="rounded border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-cyan-200 outline-none focus:border-cyan-400/50 focus:glow-cyan"
      />
      {hint && <span className="text-[10px] text-zinc-500">{hint}</span>}
    </label>
  );
}
