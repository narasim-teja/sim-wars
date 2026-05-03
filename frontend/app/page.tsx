"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { TopNav } from "@/components/TopNav";
import { HeroIllustration } from "@/components/HeroIllustration";
import { CustomSource } from "@/components/upload/CustomSource";
import { ConfigEditor } from "@/components/upload/ConfigEditor";
import { DeploymentPreview } from "@/components/upload/DeploymentPreview";
import { previewDeploymentPlan } from "@/lib/deployment-plan";
import { SCENARIO_PRESETS } from "@/lib/scenarios";
import { createSim, type RosterPreset } from "@/lib/api";
import {
  AGENT_COUNT_STEPS,
  DEFAULT_AGENT_COUNT,
  MAX_AGENTS,
  ROSTER_PRESET_LABELS,
  previewRoster,
  rosterPresetFromProtocolKind,
} from "@/lib/roster";
import { AGENT_COLORS, AGENT_LABELS, agentTypeFromId } from "@/lib/agent-colors";
import type { ExtractionOutcome, SimulationConfigParsed } from "@/lib/extraction/types";
import { cn } from "@/lib/utils";
import { ArrowDown, ChevronDown, ChevronRight, Loader2, Play } from "lucide-react";

type ScenarioId = (typeof SCENARIO_PRESETS)[number]["id"];
type Mode = "preset" | "custom";

/** Map a preset scenario id to the backend roster preset. */
const SCENARIO_TO_ROSTER: Record<ScenarioId, RosterPreset> = {
  "luna-8": "luna",
  "luna-20": "luna",
  crv: "crv",
};

export default function Home() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("preset");
  const [selected, setSelected] = useState<ScenarioId>("luna-20");
  const [maxTicks, setMaxTicks] = useState(50);
  const [tickInterval, setTickInterval] = useState(0);
  const [onChain, setOnChain] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Custom-source state
  const [customConfig, setCustomConfig] = useState<SimulationConfigParsed | null>(null);
  const [customExtractedFields, setCustomExtractedFields] = useState<string[]>([]);
  const [customEditedFields, setCustomEditedFields] = useState<Set<string>>(new Set());
  const [customMeta, setCustomMeta] = useState<ExtractionOutcome | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const presetScenario = SCENARIO_PRESETS.find((s) => s.id === selected)!;

  /**
   * Roster preset / agent count: derived from `mode + selected + protocolKind`
   * during render. The user can override either by clicking the picker or
   * sliding the count — those overrides are kept until any of the source
   * dimensions changes, at which point we reset back to the auto-derived
   * value. (React 19's `react-hooks/set-state-in-effect` rule disallows
   * synchronizing derived state via useEffect, so we compute it here.)
   */
  const autoPreset: RosterPreset =
    mode === "custom" && customMeta?.protocolKind
      ? rosterPresetFromProtocolKind(customMeta.protocolKind)
      : SCENARIO_TO_ROSTER[selected];
  const autoAgentCount =
    mode === "preset" ? presetScenario.payload.agents.length : DEFAULT_AGENT_COUNT;

  const [presetOverride, setPresetOverride] = useState<RosterPreset | null>(null);
  const [agentCountOverride, setAgentCountOverride] = useState<number | null>(null);

  // Reset overrides when the source dimensions change. This is the canonical
  // React-19 "calculate during render" pattern: a setState during render
  // triggered by a mismatched key is allowed (it bails out the render
  // immediately and re-runs with the new state).
  const presetSourceKey = `${mode}:${selected}:${customMeta?.protocolKind ?? ""}`;
  const [lastSourceKey, setLastSourceKey] = useState(presetSourceKey);
  if (presetSourceKey !== lastSourceKey) {
    setLastSourceKey(presetSourceKey);
    setPresetOverride(null);
    setAgentCountOverride(null);
  }

  const rosterPreset: RosterPreset = presetOverride ?? autoPreset;
  const agentCount: number = agentCountOverride ?? autoAgentCount;

  /**
   * Roster preview: the *backend* expander runs at launch, but the UI shows
   * an accurate breakdown (sums to exactly `agentCount`) so the user sees
   * what they'll get before paying for the run. Cheap (O(13)) — no useMemo
   * because the React Compiler can't track the override-derived deps.
   */
  const rosterPreview = previewRoster(agentCount, rosterPreset);

  /**
   * If the user picked a preset AND left the slider at the preset's native
   * size, send the static `agents[]` so the hand-written persona configs
   * (specific names, prompts) are preserved. Any other size routes through
   * the server-side expander.
   */
  const sendStaticRoster =
    mode === "preset" && agentCount === presetScenario.payload.agents.length;
  const activeAgents = sendStaticRoster ? presetScenario.payload.agents : null;

  const customReady = mode === "custom" && customConfig !== null;

  /**
   * Union of fields the LLM grounded in the source AND fields the user
   * edited in the form. The backend uses this to decide which on-chain
   * programs to deploy: a section absent from this set is treated as "the
   * user never expressed intent here, so don't deploy a program for it."
   */
  const groundedFields = useMemo<string[]>(() => {
    if (mode !== "custom") return [];
    const set = new Set<string>(customExtractedFields);
    for (const f of customEditedFields) set.add(f);
    return Array.from(set);
  }, [mode, customExtractedFields, customEditedFields]);

  /**
   * Live deploy preflight — only meaningful when on-chain is on for a
   * custom config. Computed client-side as a mirror of the backend logic so
   * the preview updates the moment the user toggles a setting; the server
   * re-runs the same logic at launch.
   */
  const deployPreview = useMemo(() => {
    if (mode !== "custom" || !customConfig) return null;
    return previewDeploymentPlan({
      config: customConfig,
      onChain,
      extractedFields: groundedFields,
    });
  }, [mode, customConfig, onChain, groundedFields]);

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
    if (agentCount < 1 || agentCount > MAX_AGENTS) {
      setError(`agentCount must be 1–${MAX_AGENTS}`);
      return;
    }

    setLaunching(true);
    try {
      const config =
        mode === "custom" && customConfig
          ? {
              ...customConfig,
              metadata: {
                ...(customConfig.metadata ?? {}),
                ...(customMeta?.protocolName ? { protocolName: customMeta.protocolName } : {}),
                ...(customMeta?.protocolKind ? { protocolKind: customMeta.protocolKind } : {}),
              },
            }
          : presetScenario.payload.config;
      const extractionMeta =
        mode === "custom" && customMeta
          ? {
              extractionMeta: {
                protocolName: customMeta.protocolName,
                protocolKind: customMeta.protocolKind,
              },
            }
          : {};
      // Mode-aware deployment: send the union of grounded + edited paths so
      // the backend skips programs the user didn't express intent for.
      // Preset scenarios omit this field — they keep the legacy "deploy
      // everything on-chain" behavior.
      const fieldsBody =
        mode === "custom" && groundedFields.length > 0
          ? { extractedFields: groundedFields }
          : {};
      // Two payload shapes:
      //   - sendStaticRoster: preserve the hand-written preset personas
      //   - else: hand the count + preset to the backend expander
      const body = sendStaticRoster && activeAgents
        ? {
            config,
            agents: activeAgents,
            tickConfig: { intervalMs: tickInterval, maxTicks },
            onChain,
            ...extractionMeta,
            ...fieldsBody,
          }
        : {
            config,
            agentCount,
            rosterPreset,
            tickConfig: { intervalMs: tickInterval, maxTicks },
            onChain,
            ...extractionMeta,
            ...fieldsBody,
          };
      const { simId } = await createSim(body);
      router.push(`/simulate/${simId}`);
    } catch (e) {
      setError((e as Error).message);
      setLaunching(false);
    }
  }

  // Agent-type breakdown for the UI: from the static roster when we'd send it,
  // otherwise synthesized from the preview.
  const agentTypes = new Map<string, number>();
  if (activeAgents) {
    for (const a of activeAgents) {
      const t = agentTypeFromId(a.id);
      agentTypes.set(t, (agentTypes.get(t) ?? 0) + 1);
    }
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
              Drop a whitepaper or a pre-built scenario. Sim Wars spawns from{" "}
              <em className="font-semibold not-italic text-zinc-900">8 to {MAX_AGENTS.toLocaleString()} LLM-powered adversaries</em>{" "}
              — whales, governance attackers, MEV bots, sybil swarms — and lets them attack your
              design until it survives, or speedruns a death spiral.
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
              <Stat header="OpenRouter-backed" sub="cheap preset for agents · quality preset for the report" />
              <Stat header={`Up to ${MAX_AGENTS.toLocaleString()} agents`} sub="server-side roster expander · veToken / LUNA / balanced presets" />
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
                      <div id="custom-config-editor" className="rounded-md border border-zinc-200 bg-white p-4">
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
              { n: "02", title: "Roster expansion", desc: "Server-side expander spawns 1–5,000 adversarial personas from veToken / LUNA / balanced archetypes." },
              { n: "03", title: "Live simulation", desc: "Per-tick LLM decisions batched in parallel. Stake / propose / vote land on Solana with real tx signatures." },
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
                02 / Adversary roster — {agentCount.toLocaleString()} agents
                <span className="ml-2 normal-case tracking-normal text-zinc-400">
                  ({rosterPreview.totalArchetypes} archetypes · {ROSTER_PRESET_LABELS[rosterPreset].label})
                </span>
              </span>
              <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-emerald-700">
                ● ready
              </span>
            </div>

            {/* Roster preset picker */}
            <RosterPresetPicker
              value={rosterPreset}
              onChange={setPresetOverride}
              autoFromKind={mode === "custom" ? customMeta?.protocolKind : undefined}
            />

            {/* Agent count slider */}
            <AgentCountSlider value={agentCount} onChange={setAgentCountOverride} />

            {sendStaticRoster && activeAgents ? (
              // Static roster path: show the hand-written personas verbatim.
              <div className="grid gap-1.5">
                {activeAgents.slice(0, 100).map((a) => {
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
                {activeAgents.length > 100 && (
                  <div className="rounded border border-dashed border-zinc-300 bg-white px-3 py-1.5 font-mono text-[11px] text-zinc-500">
                    + {activeAgents.length - 100} more personas hidden
                  </div>
                )}
              </div>
            ) : (
              // Expander path: show the synthesized preview.
              <RosterPreviewBlock preview={rosterPreview} />
            )}

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-zinc-200 pt-3">
              {sendStaticRoster && activeAgents
                ? [...agentTypes.entries()].map(([type, n]) => (
                    <div key={type} className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-600">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: AGENT_COLORS[type as keyof typeof AGENT_COLORS] }}
                      />
                      {n}× {AGENT_LABELS[type as keyof typeof AGENT_LABELS]}
                    </div>
                  ))
                : null}
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

            <ChainToggle
              checked={onChain}
              onChange={setOnChain}
            />

            {onChain && deployPreview && (
              <DeploymentPreview
                plan={deployPreview}
                onJumpToField={(path) => {
                  setEditorOpen(true);
                  // Best-effort: scroll to the editor block. The ConfigEditor
                  // doesn't currently support per-field anchors, so opening
                  // the panel + a soft scroll is the cleanest hint.
                  void path;
                  if (typeof window !== "undefined") {
                    requestAnimationFrame(() => {
                      document.getElementById("custom-config-editor")?.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                      });
                    });
                  }
                }}
              />
            )}

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
              {onChain && <span className="text-emerald-700"> · on-chain</span>}
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

function ChainToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer flex-col gap-1.5 rounded border border-zinc-200 bg-white px-3 py-2.5 hover:border-zinc-400">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
          ON-CHAIN MODE
        </span>
        <span
          role="switch"
          aria-checked={checked}
          onClick={() => onChange(!checked)}
          className={cn(
            "relative inline-flex h-5 w-9 cursor-pointer items-center rounded-full transition-colors",
            checked ? "bg-emerald-600" : "bg-zinc-300",
          )}
        >
          <span
            className={cn(
              "inline-block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform",
              checked && "translate-x-[18px]",
            )}
          />
        </span>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      <span className="text-[11px] leading-5 text-zinc-500">
        Deploy mints + AMM pool + staking + governance to the configured Solana cluster, then run.
        Each agent gets a real keypair + ATAs. Requires deployer SOL (≈ 0.5 + 5×agents). Without
        this, the sim runs against an in-memory AMM only.
      </span>
    </label>
  );
}

/**
 * Discrete log-scale slider over `AGENT_COUNT_STEPS` plus a free-form number
 * input for power users who want a value the slider doesn't hit. Keeps the
 * common cases one click away while still allowing 137-agent stress tests.
 */
function AgentCountSlider({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  // Slider position = nearest step index. Free-form input bypasses snapping.
  const stepIndex = useMemo(() => {
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < AGENT_COUNT_STEPS.length; i++) {
      const d = Math.abs(AGENT_COUNT_STEPS[i] - value);
      if (d < bestDiff) {
        best = i;
        bestDiff = d;
      }
    }
    return best;
  }, [value]);
  const cost = useMemo(() => estimateCost(value), [value]);
  return (
    <div className="flex flex-col gap-2 rounded border border-zinc-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
          AGENT COUNT
        </span>
        <input
          type="number"
          min={1}
          max={MAX_AGENTS}
          value={value}
          onChange={(e) => onChange(Math.max(1, Math.min(MAX_AGENTS, Number(e.target.value) || 1)))}
          className="w-20 rounded border border-zinc-300 bg-white px-2 py-1 text-right font-mono text-[12px] text-zinc-900 outline-none focus:border-zinc-900"
        />
      </div>
      <input
        type="range"
        min={0}
        max={AGENT_COUNT_STEPS.length - 1}
        value={stepIndex}
        onChange={(e) => onChange(AGENT_COUNT_STEPS[Number(e.target.value)])}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-zinc-200 accent-zinc-900"
      />
      <div className="flex justify-between font-mono text-[10px] text-zinc-400">
        {AGENT_COUNT_STEPS.map((s) => (
          <span key={s} className={cn(s === value && "text-zinc-900")}>{s.toLocaleString()}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-2 gap-3 border-t border-zinc-100 pt-2 font-mono text-[11px] text-zinc-600">
        <span>≈ {cost.toLocaleString(undefined, { maximumFractionDigits: 2 })} USD/30-tick run</span>
        <span className="text-right">{value > 1000 ? "Helius RPC recommended" : "localnet OK"}</span>
      </div>
    </div>
  );
}

/**
 * Rough cost estimate for the agent-decision LLM calls. The actual
 * `OPENROUTER_AGENT_PRESET` model price varies; we assume a low-cost open
 * model at ~$0.0002/decision (qwen3:8b on OpenRouter). Boost-routed `fast`
 * personas are cheaper still — under-counted on purpose so the user doesn't
 * get a sticker shock when reality comes in lower.
 */
function estimateCost(agents: number): number {
  const decisionsPerRun = agents * 30; // 30-tick default
  const usdPerCall = 0.0002;
  const reportCost = 0.005; // single report call
  return decisionsPerRun * usdPerCall + reportCost;
}

const ROSTER_PRESETS_ORDERED: RosterPreset[] = ["balanced", "stress", "lockup_resilience", "luna", "crv"];

function RosterPresetPicker({
  value, onChange, autoFromKind,
}: {
  value: RosterPreset;
  onChange: (p: RosterPreset) => void;
  autoFromKind?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded border border-zinc-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
          ROSTER PRESET
        </span>
        {autoFromKind && (
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-400">
            auto from {autoFromKind}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-5">
        {ROSTER_PRESETS_ORDERED.map((p) => {
          const active = value === p;
          const meta = ROSTER_PRESET_LABELS[p];
          return (
            <button
              key={p}
              onClick={() => onChange(p)}
              className={cn(
                "flex cursor-pointer flex-col gap-1 rounded border px-2.5 py-2 text-left transition-colors",
                active
                  ? "border-zinc-900 bg-zinc-50 shadow-[0_0_0_2px_rgba(24,24,27,0.05)]"
                  : "border-zinc-200 hover:border-zinc-400",
              )}
            >
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-700">{p}</span>
              <span className="text-[12px] font-semibold leading-tight text-zinc-900">{meta.label}</span>
              <span className="text-[10px] leading-snug text-zinc-500">{meta.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Roster preview block: aggregated archetype breakdown for an N-agent
 * expander run. Shown when the static roster JSON wouldn't be sent.
 */
function RosterPreviewBlock({ preview }: { preview: ReturnType<typeof previewRoster> }) {
  return (
    <div className="rounded border border-dashed border-zinc-300 bg-white">
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 p-3 sm:grid-cols-3">
        {preview.byArchetype.map((a) => {
          const colorKey = (
            {
              WHALE: "whale", GOV: "governance_attacker", SYBIL: "sybil", MEV: "mev_bot",
              FARMER: "yield_farmer", DEGEN: "retail_degen", HOLDER: "long_term_holder",
              ARB: "arbitrageur", TREASURY: "treasury", LP: "lp_provider",
              ANALYST: "analyst", INSIDER: "insider", PANIC: "panic_seller",
            } as Record<string, keyof typeof AGENT_COLORS>
          )[a.prefix];
          return (
            <div key={a.prefix} className="flex items-center gap-2 font-mono text-[11px] text-zinc-700">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: colorKey ? AGENT_COLORS[colorKey] : "#888" }}
              />
              <span className="font-semibold">{a.count}×</span>
              <span className="truncate text-zinc-600">{a.label}</span>
            </div>
          );
        })}
      </div>
      <div className="border-t border-zinc-200 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
        Backend expander runs at launch · ratios sum to {preview.count.toLocaleString()}
      </div>
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
