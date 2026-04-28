"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TopNav } from "@/components/TopNav";
import { HeroIllustration } from "@/components/HeroIllustration";
import { SCENARIO_PRESETS } from "@/lib/scenarios";
import { createSim } from "@/lib/api";
import { AGENT_COLORS, AGENT_LABELS, agentTypeFromId } from "@/lib/agent-colors";
import { cn } from "@/lib/utils";
import { ArrowDown, Loader2, Play } from "lucide-react";

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
    <div className="flex min-h-screen flex-col bg-white">
      <TopNav />

      {/* HERO */}
      <section className="relative px-6 py-14 sm:py-20">
        <div className="mx-auto grid w-full max-w-7xl items-center gap-10 lg:grid-cols-[1fr_minmax(0,520px)]">
          <div className="flex flex-col gap-6">
            <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
              <span>An adversarial swarm engine</span>
              <span className="text-zinc-300">/</span>
              <span>v0.2 · phase 2 preview</span>
            </div>
            <h1 className="text-[44px] font-semibold leading-[1.05] tracking-tight text-zinc-900 sm:text-[56px]">
              Upload your tokenomics.
              <br />
              <span className="text-zinc-400">Stress-test the future.</span>
            </h1>
            <p className="max-w-xl text-[15px] leading-7 text-zinc-600">
              Drop a whitepaper or a pre-built scenario. Sim Wars spawns up to <em className="font-semibold not-italic text-zinc-900">20 LLM-powered adversaries</em> — whales,
              governance attackers, MEV bots, sybil swarms — and lets them attack your design until it survives,
              or speedruns a death spiral.
            </p>
            <p className="font-mono text-[12px] uppercase tracking-[0.18em] text-zinc-700">
              <span className="border-b border-zinc-300 pb-0.5">
                Run the simulation. Find the failure mode. Ship the fix.
              </span>
            </p>
            <div className="mt-6 flex items-center gap-2 text-zinc-300">
              <ArrowDown className="h-4 w-4" />
              <span className="font-mono text-[10px] uppercase tracking-[0.25em]">Continue</span>
            </div>
          </div>

          <div className="relative">
            <HeroIllustration className="w-full max-w-[520px]" />
          </div>
        </div>
      </section>

      {/* SYSTEM STATUS */}
      <section className="border-t border-zinc-200 bg-white px-6 py-12">
        <div className="mx-auto grid w-full max-w-7xl gap-10 lg:grid-cols-[1fr_minmax(0,560px)]">
          <div className="flex flex-col gap-6">
            <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
              <span className="block h-2 w-2 bg-zinc-900" />
              System status
            </div>
            <h2 className="text-4xl font-semibold tracking-tight text-zinc-900">
              Ready
            </h2>
            <p className="max-w-md text-[14px] leading-7 text-zinc-600">
              Engine is idle. Pick a scenario to seed the world, configure the tick loop, and deploy a fresh adversarial run.
            </p>

            <div className="grid grid-cols-2 gap-6 pt-2">
              <Stat header="Low cost" sub="≈ $5/run with mock-LLM" />
              <Stat header="High coverage" sub="up to 1M agents (engine cap)" />
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between border-b border-zinc-200 pb-2 text-zinc-700">
              <span className="font-mono text-[11px] uppercase tracking-[0.25em]">01 / Scenario seed</span>
              <span className="font-mono text-[11px] tracking-[0.25em] text-zinc-400">JSON · pre-built</span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {SCENARIO_PRESETS.map((s) => {
                const active = s.id === selected;
                return (
                  <button
                    key={s.id}
                    onClick={() => {
                      setSelected(s.id);
                      setMaxTicks(s.defaultMaxTicks);
                    }}
                    className={cn(
                      "flex cursor-pointer flex-col gap-1.5 rounded-md border bg-white p-4 text-left transition-all",
                      active
                        ? "border-zinc-900 shadow-[0_0_0_3px_rgba(24,24,27,0.06)]"
                        : "border-zinc-200 hover:border-zinc-400",
                    )}
                  >
                    <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
                      {s.id}
                    </span>
                    <span className="text-base font-semibold text-zinc-900">{s.label}</span>
                    <span className="text-[12px] leading-5 text-zinc-500">{s.description}</span>
                    <span className="mt-2 font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-700">
                      {s.payload.agents.length} agents · {s.defaultMaxTicks} default ticks
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* WORKFLOW SEQUENCE */}
      <section className="border-t border-zinc-200 px-6 py-12">
        <div className="mx-auto w-full max-w-7xl">
          <div className="mb-6 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
            <span className="block h-2 w-2 rotate-45 border border-zinc-900" />
            Workflow sequence
          </div>

          <ol className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {[
              { n: "01", title: "Seed extraction", desc: "Tokenomics parameters parsed from PDF, doc, or JSON. LLM auto-fills missing values." },
              { n: "02", title: "Roster generation", desc: "20 adversarial personas with goals, risk tolerance, and visibility rules baked in." },
              { n: "03", title: "Live simulation", desc: "Tick loop runs LLM decisions in parallel. Force graph + metrics stream to the dashboard." },
              { n: "04", title: "Failure report", desc: "Resilience score, attack timeline, and parameter recommendations after the run." },
            ].map((s) => (
              <li key={s.n} className="flex flex-col gap-2 border-l-2 border-zinc-200 pl-4">
                <span className="section-number text-[13px] uppercase tracking-[0.2em] text-zinc-500">{s.n}</span>
                <span className="text-base font-semibold text-zinc-900">{s.title}</span>
                <span className="text-[12px] leading-5 text-zinc-500">{s.desc}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ROSTER + RUN PARAMS */}
      <section className="border-t border-zinc-200 px-6 py-12">
        <div className="mx-auto grid w-full max-w-7xl gap-10 lg:grid-cols-[1fr_minmax(0,420px)]">
          {/* Roster */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between border-b border-zinc-200 pb-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
                02 / Adversary roster — {preset.payload.agents.length} agents
              </span>
              <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-emerald-700">
                ● ready
              </span>
            </div>
            <div className="grid gap-1.5">
              {preset.payload.agents.map((a) => {
                const t = agentTypeFromId(a.id);
                return (
                  <div
                    key={a.id}
                    className="flex items-center gap-3 rounded border border-zinc-100 bg-white px-3 py-1.5"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ background: AGENT_COLORS[t] }}
                    />
                    <span className="font-mono text-[12px] font-semibold text-zinc-900">{a.id}</span>
                    <span className="ml-auto font-mono text-[11px] text-zinc-500">{AGENT_LABELS[t]}</span>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-zinc-200 pt-3">
              {[...agentTypes.entries()].map(([type, n]) => (
                <div key={type} className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-600">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: AGENT_COLORS[type as keyof typeof AGENT_COLORS] }}
                  />
                  {n}× {AGENT_LABELS[type as keyof typeof AGENT_LABELS]}
                </div>
              ))}
            </div>
          </div>

          {/* Tick params + launch */}
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-zinc-200 pb-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
                03 / Tick parameters
              </span>
              <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-400">editable</span>
            </div>

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

            <button
              onClick={launch}
              disabled={launching}
              className={cn(
                "mt-2 flex h-12 cursor-pointer items-center justify-center gap-2 rounded bg-zinc-900 font-mono text-[12px] uppercase tracking-[0.25em] text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {launching ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> launching…
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 fill-current" /> Deploy &amp; simulate
                </>
              )}
            </button>

            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
              POST <span className="text-zinc-700">/api/sim</span> · spawns worker subprocess
            </p>

            {error && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700">
                {error}
              </div>
            )}
          </div>
        </div>
      </section>

      <footer className="border-t border-zinc-200 px-6 py-6">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
          <span>SIMWARS · MIT license · 2026</span>
          <span>Solana devnet · Bun · Anchor 1.0</span>
        </div>
      </footer>
    </div>
  );
}

function Stat({ header, sub }: { header: string; sub: string }) {
  return (
    <div className="flex flex-col gap-1 border-l-2 border-zinc-900 pl-3">
      <span className="text-2xl font-semibold tracking-tight text-zinc-900">{header}</span>
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-500">{sub}</span>
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
        className="rounded border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 outline-none focus:border-zinc-900"
      />
      {hint && <span className="text-[11px] text-zinc-500">{hint}</span>}
    </label>
  );
}
