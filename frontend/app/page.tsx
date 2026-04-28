"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { TopNav } from "@/components/TopNav";
import { HeroIllustration } from "@/components/HeroIllustration";
import { CustomSource } from "@/components/upload/CustomSource";
import { ConfigEditor } from "@/components/upload/ConfigEditor";
import { SCENARIO_PRESETS } from "@/lib/scenarios";
import { createSim } from "@/lib/api";
import { AGENT_COLORS, AGENT_LABELS, agentTypeFromId } from "@/lib/agent-colors";
import type { ExtractionOutcome, SimulationConfigParsed } from "@/lib/extraction/types";
import { cn } from "@/lib/utils";
import { ArrowDown, ChevronDown, ChevronRight, Loader2, Play } from "lucide-react";

type ScenarioId = (typeof SCENARIO_PRESETS)[number]["id"];
type Mode = "preset" | "custom";

const DEFAULT_AGENT_PRESET = "luna-20" as const;

export default function Home() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("preset");
  const [selected, setSelected] = useState<ScenarioId>("luna-20");
  const [maxTicks, setMaxTicks] = useState(50);
  const [tickInterval, setTickInterval] = useState(0);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Custom-source state
  const [customConfig, setCustomConfig] = useState<SimulationConfigParsed | null>(null);
  const [customExtractedFields, setCustomExtractedFields] = useState<string[]>([]);
  const [customEditedFields, setCustomEditedFields] = useState<Set<string>>(new Set());
  const [customMeta, setCustomMeta] = useState<ExtractionOutcome | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const presetScenario = SCENARIO_PRESETS.find((s) => s.id === selected)!;

  // The roster used for both display and launch:
  //   - preset mode → the selected preset's roster
  //   - custom mode → the LUNA-20 default roster (persona extraction is out of scope)
  const activeAgents =
    mode === "custom"
      ? SCENARIO_PRESETS.find((s) => s.id === DEFAULT_AGENT_PRESET)!.payload.agents
      : presetScenario.payload.agents;

  const customReady = mode === "custom" && customConfig !== null;

  const validation = useMemo(() => {
    if (mode === "preset" || !customConfig) return { ok: true as const, blockers: [] as string[], warnings: [] as string[] };
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (customConfig.token.totalSupply <= 0) blockers.push("token.totalSupply must be > 0");
    if (customConfig.amm.initialPrice <= 0) blockers.push("amm.initialPrice must be > 0");
    if (customConfig.amm.initialLiquidity <= 0) blockers.push("amm.initialLiquidity must be > 0");
    const allocSum = customConfig.token.allocations.reduce((s, a) => s + (a.percent || 0), 0);
    if (Math.abs(allocSum - 100) >= 0.5 && customConfig.token.allocations.length > 0) {
      warnings.push(`allocations sum to ${allocSum.toFixed(2)}%, not 100% — engine will run anyway`);
    }
    return { ok: blockers.length === 0, blockers, warnings };
  }, [mode, customConfig]);

  // Edit handler for the config form: writes into customConfig and marks paths as edited.
  const onEditField = useCallback(
    (path: string, next: unknown) => {
      setCustomConfig((prev) => {
        if (!prev) return prev;
        return setByPath(prev, path, next);
      });
      setCustomEditedFields((prev) => {
        const nextSet = new Set(prev);
        nextSet.add(path);
        return nextSet;
      });
    },
    [],
  );

  const onExtracted = useCallback((outcome: ExtractionOutcome) => {
    setCustomConfig(outcome.config);
    setCustomExtractedFields(outcome.extractedFields);
    setCustomEditedFields(new Set());
    setCustomMeta(outcome);
    setEditorOpen(false);
  }, []);

  const onCustomCleared = useCallback(() => {
    setCustomConfig(null);
    setCustomExtractedFields([]);
    setCustomEditedFields(new Set());
    setCustomMeta(null);
    setEditorOpen(false);
  }, []);

  async function launch() {
    setError(null);
    if (mode === "custom") {
      if (!customConfig) {
        setError("extract a whitepaper first, or switch to a preset");
        return;
      }
      if (!validation.ok) {
        setError(validation.blockers.join(" · "));
        return;
      }
    }

    setLaunching(true);
    try {
      const config =
        mode === "custom" && customConfig ? customConfig : presetScenario.payload.config;
      const body = {
        config,
        agents: activeAgents,
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
  for (const a of activeAgents) {
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

      {/* TOKENOMICS SOURCE */}
      <section className="border-t border-zinc-200 bg-white px-6 py-12">
        <div className="mx-auto grid w-full max-w-7xl gap-10 lg:grid-cols-[1fr_minmax(0,560px)]">
          <div className="flex flex-col gap-6">
            <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
              <span className="block h-2 w-2 bg-zinc-900" />
              System status
            </div>
            <h2 className="text-4xl font-semibold tracking-tight text-zinc-900">Ready</h2>
            <p className="max-w-md text-[14px] leading-7 text-zinc-600">
              Engine is idle. Pick a pre-built scenario or upload your own whitepaper — Sim Wars
              extracts tokenomics and seeds a fresh adversarial run.
            </p>

            <div className="grid grid-cols-2 gap-6 pt-2">
              <Stat header="Low cost" sub="≈ $5/run with mock-LLM" />
              <Stat header="High coverage" sub="up to 1M agents (engine cap)" />
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between border-b border-zinc-200 pb-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-700">
                01 / Tokenomics source
              </span>
              <ModeToggle mode={mode} onChange={setMode} />
            </div>

            {mode === "preset" ? (
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
            ) : (
              <div className="flex flex-col gap-3">
                <CustomSource onExtracted={onExtracted} onCleared={onCustomCleared} />

                {customReady && customConfig && (
                  <div className="flex flex-col gap-3">
                    <button
                      onClick={() => setEditorOpen((v) => !v)}
                      className="flex cursor-pointer items-center justify-between rounded-md border border-zinc-200 bg-white px-3 py-2 text-left hover:border-zinc-400"
                    >
                      <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-700">
                        {editorOpen ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                        Edit parameters
                      </span>
                      <span className="font-mono text-[10px] tracking-[0.2em] text-zinc-500">
                        {customExtractedFields.length} extracted ·{" "}
                        {customEditedFields.size} edited
                      </span>
                    </button>

                    {editorOpen && (
                      <div className="rounded-md border border-zinc-200 bg-white p-4">
                        <ConfigEditor
                          config={customConfig}
                          extractedFields={customExtractedFields}
                          editedFields={customEditedFields}
                          onChange={onEditField}
                        />
                      </div>
                    )}

                    {validation.warnings.length > 0 && (
                      <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 font-mono text-[11px] text-amber-800">
                        {validation.warnings.map((w, i) => (
                          <div key={i}>⚠ {w}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
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
              { n: "01", title: "Seed extraction", desc: "Tokenomics parameters parsed from PDF, GitHub, or raw markdown via OpenRouter preset." },
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
                02 / Adversary roster — {activeAgents.length} agents
              </span>
              <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-emerald-700">
                ● ready
              </span>
            </div>
            {mode === "custom" && (
              <div className="rounded border border-dashed border-zinc-300 bg-white px-3 py-2 font-mono text-[11px] text-zinc-600">
                Personas not extracted from whitepaper — using LUNA-20 default roster.
              </div>
            )}
            <div className="grid gap-1.5">
              {activeAgents.map((a) => {
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
              disabled={launching || (mode === "custom" && !customReady)}
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
              POST <span className="text-zinc-700">/api/sim</span>
              {mode === "custom" && customMeta && (
                <span className="text-zinc-500">
                  {" · "}config from <span className="text-zinc-700">{truncate(customMeta.source.label, 38)}</span>
                </span>
              )}
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

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-sm border border-zinc-200 bg-zinc-50 p-0.5 font-mono text-[10px] uppercase tracking-[0.2em]">
      <button
        onClick={() => onChange("preset")}
        className={cn(
          "cursor-pointer rounded-sm px-2.5 py-1 transition-colors",
          mode === "preset" ? "bg-zinc-900 text-white" : "text-zinc-600 hover:text-zinc-900",
        )}
      >
        Preset
      </button>
      <button
        onClick={() => onChange("custom")}
        className={cn(
          "cursor-pointer rounded-sm px-2.5 py-1 transition-colors",
          mode === "custom" ? "bg-zinc-900 text-white" : "text-zinc-600 hover:text-zinc-900",
        )}
      >
        Whitepaper
      </button>
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

/**
 * Immutably set a value at a dotted path inside the config.
 * Used by ConfigEditor's onChange to update nested fields.
 */
function setByPath<T extends Record<string, unknown>>(obj: T, path: string, value: unknown): T {
  const keys = path.split(".");
  const head = keys[0];
  const rest = keys.slice(1);
  const current = (obj as Record<string, unknown>)[head];
  if (rest.length === 0) {
    return { ...obj, [head]: value };
  }
  const child =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  return { ...obj, [head]: setByPath(child as Record<string, unknown>, rest.join("."), value) };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
