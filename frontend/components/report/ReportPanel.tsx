"use client";

import { useEffect, useState } from "react";
import { Copy, Download, ExternalLink } from "lucide-react";
import type { SimulationReport, ResilienceGrade } from "@/lib/report";
import { cn } from "@/lib/utils";

const GRADE_COLOR: Record<ResilienceGrade, { bg: string; ring: string; fg: string }> = {
  S: { bg: "bg-emerald-50",  ring: "ring-emerald-200", fg: "text-emerald-700" },
  A: { bg: "bg-emerald-50",  ring: "ring-emerald-200", fg: "text-emerald-700" },
  B: { bg: "bg-lime-50",     ring: "ring-lime-200",    fg: "text-lime-700" },
  C: { bg: "bg-amber-50",    ring: "ring-amber-200",   fg: "text-amber-800" },
  D: { bg: "bg-orange-50",   ring: "ring-orange-200",  fg: "text-orange-800" },
  F: { bg: "bg-red-50",      ring: "ring-red-300",     fg: "text-red-700" },
};

export function ReportPanel({
  report,
  /** When true, renders without the floating share/print toolbar — used in /report/[id]. */
  embedded = false,
  shareUrl,
}: {
  report: SimulationReport;
  embedded?: boolean;
  shareUrl?: string;
}) {
  const grade = report.resilienceGrade;
  const palette = GRADE_COLOR[grade];

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const onCopy = () => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl).then(() => setCopied(true)).catch(() => {});
  };

  return (
    <article className="thin-scroll mx-auto flex w-full max-w-5xl flex-col gap-5 overflow-y-auto bg-white p-6 print:max-w-none print:overflow-visible print:p-0">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-200 pb-5">
        <div className="flex flex-col gap-2">
          <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-zinc-500">
            Sim-wars · post-mortem
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Resilience report</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[11px] text-zinc-500">
            <span>sim {report.simId.slice(0, 12)}</span>
            <span>·</span>
            <span>{report.meta.totalTicks} ticks · {report.meta.agentCount} agents</span>
            <span>·</span>
            <span className={report.meta.deathSpiralDetected ? "text-red-700" : "text-zinc-500"}>
              status: {report.meta.finalStatus}
            </span>
            <span>·</span>
            <span>{new Date(report.meta.generatedAtMs).toLocaleString()}</span>
            <LLMBadge model={report.meta.llmModel} />
          </div>
        </div>

        {/* Resilience grade pill */}
        <div className={cn("flex flex-col items-end gap-1 rounded-md border px-4 py-3 text-right ring-1", palette.bg, palette.ring)}>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">Resilience</div>
          <div className={cn("text-5xl font-bold tabular-nums leading-none", palette.fg)}>{grade}</div>
          <div className={cn("font-mono text-[11px] tabular-nums", palette.fg)}>
            {report.resilienceScore} / 100
          </div>
        </div>
      </header>

      {/* Toolbar */}
      {!embedded && (
        <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.print()}
              className="flex h-9 cursor-pointer items-center gap-1.5 rounded border border-zinc-300 bg-white px-3 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-700 hover:border-zinc-900 hover:bg-zinc-50"
            >
              <Download className="h-3.5 w-3.5" /> Print / save PDF
            </button>
            {shareUrl && (
              <>
                <button
                  onClick={onCopy}
                  className="flex h-9 cursor-pointer items-center gap-1.5 rounded border border-zinc-300 bg-white px-3 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-700 hover:border-zinc-900 hover:bg-zinc-50"
                >
                  <Copy className="h-3.5 w-3.5" /> {copied ? "copied" : "Copy share link"}
                </button>
                <a
                  href={shareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex h-9 cursor-pointer items-center gap-1.5 rounded border border-zinc-300 bg-white px-3 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-700 hover:border-zinc-900 hover:bg-zinc-50"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open
                </a>
              </>
            )}
          </div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-400">
            shareable URL · printable
          </div>
        </div>
      )}

      {/* Stat strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Initial price"  value={`$${formatN(report.meta.initialPrice)}`} />
        <Stat label="Final price"    value={`$${formatN(report.meta.finalPrice)}`} delta={report.meta.pricePctChange} />
        <Stat label="Final Gini"     value={report.meta.finalGini.toFixed(3)} />
        <Stat
          label="Reserve survival"
          value={report.meta.finalReservePct == null ? "n/a" : `${report.meta.finalReservePct.toFixed(1)}%`}
        />
      </div>

      <Section number="01" title="Executive summary" subtitle="What happened">
        <p className="text-[13.5px] leading-7 text-zinc-800">{report.executiveSummary}</p>
      </Section>

      <Section
        number="02"
        title="Failure modes detected"
        subtitle={`${report.failureModes.length} mode${report.failureModes.length === 1 ? "" : "s"} surfaced`}
      >
        {report.failureModes.length === 0 ? (
          <Empty>No structural failure modes detected.</Empty>
        ) : (
          <ul className="flex flex-col gap-3">
            {report.failureModes.map((m, i) => (
              <li key={i} className="rounded-md border border-zinc-200 bg-white p-3">
                <div className="mb-1 flex flex-wrap items-baseline gap-3">
                  <span className="text-[14px] font-semibold text-zinc-900">{m.name}</span>
                  <SeverityPill value={m.severity} />
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                    detected at tick {m.detectedAtTick}
                  </span>
                </div>
                <p className="text-[12.5px] leading-6 text-zinc-700">{m.description}</p>
                {m.responsibleAgents.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {m.responsibleAgents.map((a) => (
                      <span
                        key={a}
                        className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[10px] text-zinc-700"
                      >
                        {a}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        number="03"
        title="Most dangerous agents"
        subtitle="Ranked by realized USD PnL"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-zinc-200 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                <th className="py-1.5 pr-3">#</th>
                <th className="py-1.5 pr-3">agent</th>
                <th className="py-1.5 pr-3">type</th>
                <th className="py-1.5 pr-3 text-right">PnL (USDC)</th>
                <th className="py-1.5 pr-3 text-right">actions</th>
                <th className="py-1.5 pr-3 text-right">largest trade</th>
                <th className="py-1.5 pr-3 text-right">first exit</th>
                <th className="py-1.5">behavior</th>
              </tr>
            </thead>
            <tbody>
              {report.agentRankings.map((r, i) => (
                <tr
                  key={r.agentId}
                  className="border-b border-zinc-100 font-mono text-[11.5px] text-zinc-800 last:border-b-0"
                >
                  <td className="py-1.5 pr-3 text-zinc-500">{i + 1}</td>
                  <td className="py-1.5 pr-3 font-semibold text-zinc-900">{r.agentId}</td>
                  <td className="py-1.5 pr-3 text-zinc-600">{r.agentType}</td>
                  <td
                    className={cn(
                      "py-1.5 pr-3 text-right tabular-nums",
                      r.realizedPnlUsd > 0 ? "text-emerald-700" : r.realizedPnlUsd < 0 ? "text-red-700" : "text-zinc-700",
                    )}
                  >
                    {formatSignedUsd(r.realizedPnlUsd)}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{r.totalActions}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatN(r.largestTradeAmount)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {r.firstExitTick == null ? "—" : `t${r.firstExitTick}`}
                  </td>
                  <td className="py-1.5 text-zinc-600">{r.characterization}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        number="04"
        title="Attack vectors"
        subtitle={`${report.attackVectors.length} vector${report.attackVectors.length === 1 ? "" : "s"} identified`}
      >
        {report.attackVectors.length === 0 ? (
          <Empty>No coordinated attack vectors identified by the model.</Empty>
        ) : (
          <ul className="flex flex-col gap-3">
            {report.attackVectors.map((v, i) => (
              <li key={i} className="rounded-md border border-zinc-200 bg-white p-3">
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <span className="text-[14px] font-semibold text-zinc-900">{v.label}</span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                    t{v.startTick} → t{v.endTick}
                  </span>
                </div>
                <ol className="ml-5 list-decimal space-y-1 text-[12.5px] leading-6 text-zinc-700 marker:text-zinc-400">
                  {v.timeline.map((step, j) => (
                    <li key={j}>{step}</li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        number="05"
        title="Recommendations"
        subtitle={`${report.recommendations.length} parameter change${report.recommendations.length === 1 ? "" : "s"}`}
      >
        {report.recommendations.length === 0 ? (
          <Empty>No parameter changes suggested.</Empty>
        ) : (
          <ul className="flex flex-col gap-3">
            {report.recommendations.map((r, i) => (
              <li key={i} className="rounded-md border border-zinc-200 bg-white p-3">
                <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono text-[12px] font-semibold text-zinc-900">{r.parameter}</span>
                  <span className="font-mono text-[11px] text-zinc-500">→</span>
                  <span className="font-mono text-[12px] text-emerald-800">{r.suggestedValue}</span>
                </div>
                <p className="text-[12.5px] leading-6 text-zinc-700">{r.rationale}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        number="06"
        title="Comparison to historical collapses"
        subtitle="similarity heuristic"
      >
        {report.comparison ? (
          <div className="flex flex-col gap-2 rounded-md border border-zinc-200 bg-white p-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[14px] font-semibold text-zinc-900">{report.comparison.collapseName}</span>
              <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                similarity {report.comparison.similarityScore}%
              </span>
            </div>
            <p className="text-[12.5px] leading-6 text-zinc-700">{report.comparison.reasoning}</p>
          </div>
        ) : (
          <Empty>No close historical analogue identified.</Empty>
        )}
      </Section>

      {report.narrative && (
        <Section number="07" title="Raw model narrative" subtitle="LLM transcript (debug / advanced)">
          <pre className="thin-scroll whitespace-pre-wrap break-words rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-[11px] leading-5 text-zinc-700">
            {report.narrative}
          </pre>
        </Section>
      )}

      <footer className="border-t border-zinc-200 pt-4 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-400">
        sim-wars · adversarial tokenomics simulator · MIT
      </footer>
    </article>
  );
}

// ───────────────────────── helpers ─────────────────────────

function Section({
  number, title, subtitle, children,
}: {
  number: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-zinc-200 bg-white print:break-inside-avoid">
      <header className="flex items-baseline justify-between gap-3 border-b border-zinc-100 px-4 py-3">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">{number}</span>
          <span className="text-[14px] font-semibold text-zinc-900">{title}</span>
        </div>
        {subtitle && (
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">{subtitle}</span>
        )}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Stat({ label, value, delta }: { label: string; value: string; delta?: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-zinc-200 bg-white p-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">{label}</span>
      <span className="text-[18px] font-semibold tabular-nums text-zinc-900">{value}</span>
      {delta !== undefined && (
        <span
          className={cn(
            "font-mono text-[11px] tabular-nums",
            delta > 0 ? "text-emerald-700" : delta < 0 ? "text-red-700" : "text-zinc-500",
          )}
        >
          {delta > 0 ? "+" : ""}{delta.toFixed(2)}%
        </span>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded border border-dashed border-zinc-200 px-3 py-4 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-400">
      {children}
    </div>
  );
}

/**
 * LLM provenance badge. Green when on a hosted preset (proves the report
 * actually ran through OpenRouter); amber when on a local model (used to
 * indicate a misconfigured run that fell back to Ollama — that path is
 * removed but old reports may still surface it).
 */
function LLMBadge({ model }: { model: string }) {
  const isOpenRouter = model.startsWith("openrouter:");
  const isLocal = model.startsWith("ollama:") || model === "mock";
  const palette = isOpenRouter
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : isLocal
      ? "bg-amber-50 text-amber-800 border-amber-200"
      : "bg-zinc-50 text-zinc-700 border-zinc-200";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]",
        palette,
      )}
      title={isLocal ? "Heads up: ran on a local fallback model — check OPENROUTER_API_KEY." : undefined}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", isOpenRouter ? "bg-emerald-600" : isLocal ? "bg-amber-600" : "bg-zinc-400")} />
      {model.length > 50 ? model.slice(0, 50) + "…" : model}
    </span>
  );
}

function SeverityPill({ value }: { value: number }) {
  const cls = value >= 80
    ? "bg-red-50 text-red-700 border-red-200"
    : value >= 60
      ? "bg-orange-50 text-orange-800 border-orange-200"
      : value >= 40
        ? "bg-amber-50 text-amber-800 border-amber-200"
        : "bg-zinc-50 text-zinc-700 border-zinc-200";
  return (
    <span className={cn("rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em]", cls)}>
      sev {value}
    </span>
  );
}

function formatN(n: number): string {
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function formatSignedUsd(n: number): string {
  const sign = n >= 0 ? "+" : "−";
  const abs = Math.abs(n);
  return `${sign}$${formatN(abs)}`;
}
