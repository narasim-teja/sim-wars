"use client";

import { Check, Minus, AlertTriangle } from "lucide-react";
import { type DeploymentPlanPreview, PROGRAM_LABELS } from "@/lib/deployment-plan";
import { cn } from "@/lib/utils";

/**
 * Shows the deploy preflight in two columns: programs that will deploy
 * (green check) and programs intentionally skipped (with the reason and a
 * hint about which field to fill to enable them).
 *
 * Rendered only when on-chain mode is on and there's a custom config — for
 * preset scenarios the legacy "deploy everything" path applies and there's
 * nothing to preview.
 */
export function DeploymentPreview({
  plan,
  /** Optional: clicking a skipped program opens the editor scrolled to its section. */
  onJumpToField,
}: {
  plan: DeploymentPlanPreview;
  onJumpToField?: (path: string) => void;
}) {
  const willDeploy = (Object.keys(plan.programs) as (keyof DeploymentPlanPreview["programs"])[])
    .filter((k) => plan.programs[k]);
  // Static order so the row doesn't shuffle as the user edits.
  const ORDER: (keyof DeploymentPlanPreview["programs"])[] = ["tokenMint", "ammDex", "staking", "governance"];
  const ordered = ORDER.filter((p) => willDeploy.includes(p));

  return (
    <div className="rounded border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-700">
          Deployment preview
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          {plan.symbols.base}/{plan.symbols.quote} · {ordered.length}/{ORDER.length} programs
        </span>
      </div>

      <div className="grid gap-1.5 p-3">
        {ORDER.map((p) => {
          const enabled = plan.programs[p];
          const skip = plan.skipped.find((s) => s.program === (p as string));
          return (
            <ProgramRow
              key={p}
              label={PROGRAM_LABELS[p]}
              enabled={enabled}
              reason={skip?.reason}
              hint={skip?.enableHint}
              onClickHint={
                skip && onJumpToField
                  ? () => onJumpToField(skip.enableHint.split(" ")[0]!)
                  : undefined
              }
            />
          );
        })}
      </div>

      {plan.blockers.length > 0 && (
        <div className="border-t border-red-200 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700">
          {plan.blockers.map((b, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" /> {b}
            </div>
          ))}
        </div>
      )}

      {plan.warnings.length > 0 && (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-2 font-mono text-[11px] text-amber-800">
          {plan.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProgramRow({
  label,
  enabled,
  reason,
  hint,
  onClickHint,
}: {
  label: string;
  enabled: boolean;
  reason?: string;
  hint?: string;
  onClickHint?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded border px-2.5 py-1.5",
        enabled
          ? "border-emerald-200 bg-emerald-50/40"
          : "border-dashed border-zinc-200 bg-zinc-50/30",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {enabled ? (
            <Check className="h-3.5 w-3.5 text-emerald-700" />
          ) : (
            <Minus className="h-3.5 w-3.5 text-zinc-400" />
          )}
          <span className="text-[12.5px] font-semibold text-zinc-900">{label}</span>
        </div>
        <span
          className={cn(
            "font-mono text-[9px] uppercase tracking-[0.2em]",
            enabled ? "text-emerald-700" : "text-zinc-500",
          )}
        >
          {enabled ? "deploy" : "skip"}
        </span>
      </div>
      {!enabled && reason && (
        <div className="flex flex-col gap-0.5 pl-5 text-[11px] leading-5 text-zinc-600">
          <span>{reason}</span>
          {hint && (
            <span className="font-mono text-[10px] tracking-tight text-zinc-500">
              fill <span className="text-zinc-700">{hint}</span> to enable
              {onClickHint && (
                <button
                  type="button"
                  onClick={onClickHint}
                  className="ml-1 cursor-pointer underline hover:text-zinc-900"
                >
                  open editor
                </button>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
