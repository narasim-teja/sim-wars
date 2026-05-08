import Link from "next/link";
import { Skull, ShieldCheck, ArrowRight } from "lucide-react";
import type { DemoCard } from "@/lib/api";

/**
 * Hero-level "Watch a replay" cards. Pure render — pre-recorded NDJSON
 * runs baked into the image, no OpenRouter key needed. We sort death
 * spirals first (the punch-line story), then survivors by grade so the
 * LUNA collapse always leads when it ships.
 */
export function ReplayCards({ demos }: { demos: DemoCard[] }) {
  const sorted = [...demos].sort((a, b) => {
    if (a.deathSpiralDetected !== b.deathSpiralDetected) {
      return a.deathSpiralDetected ? -1 : 1;
    }
    return (b.resilienceScore ?? 0) - (a.resilienceScore ?? 0);
  });
  const visible = sorted.slice(0, 3);
  const overflow = sorted.length - visible.length;

  return (
    <section className="border-t border-zinc-200 bg-zinc-50/50 px-6 py-12">
      <div className="mx-auto w-full max-w-7xl">
        <div className="mb-6 flex items-end justify-between gap-6">
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
              <span className="block h-2 w-2 rounded-full bg-zinc-900" />
              Watch a replay · no key required
            </span>
            <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 sm:text-3xl">
              Three pre-recorded simulations.
            </h2>
            <p className="max-w-xl text-[14px] leading-relaxed text-zinc-600">
              Each card opens a full event-stream replay: token price, agent feed,
              governance traffic, and the post-sim resilience report. Death spiral or
              survival, the data is from real LLM-driven runs.
            </p>
          </div>
          {overflow > 0 && (
            <Link
              href="/demos"
              className="flex shrink-0 items-center gap-1 font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-700 hover:text-zinc-900"
            >
              {overflow} more
              <ArrowRight className="h-3 w-3" />
            </Link>
          )}
        </div>

        {visible.length === 0 ? (
          <div className="grid h-40 place-items-center rounded-md border border-dashed border-zinc-300 bg-white font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-400">
            no replays available
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((d) => (
              <ReplayCard key={d.simId} demo={d} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ReplayCard({ demo }: { demo: DemoCard }) {
  const Icon = demo.deathSpiralDetected ? Skull : ShieldCheck;
  const accent = demo.deathSpiralDetected ? "text-red-700" : "text-emerald-700";
  const accentBorder = demo.deathSpiralDetected
    ? "hover:border-red-500"
    : "hover:border-emerald-500";

  return (
    <Link
      href={`/simulate/${demo.simId}`}
      className={`group flex flex-col gap-3 rounded-md border border-zinc-200 bg-white p-5 transition-colors ${accentBorder} hover:bg-zinc-50/40`}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
          {demo.simId.slice(0, 8)}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
          {demo.totalTicks} ticks
        </span>
      </div>
      <div className="flex items-start gap-2">
        <Icon className={`mt-1 h-4 w-4 shrink-0 ${accent}`} />
        <h3 className="text-[17px] font-semibold leading-snug text-zinc-900">
          {demo.name}
        </h3>
      </div>
      <p className="text-[13px] leading-relaxed text-zinc-600">{demo.description}</p>
      <div className="mt-auto flex items-center justify-between border-t border-zinc-100 pt-3">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em]">
          {demo.resilienceGrade && (
            <span className={accent}>grade {demo.resilienceGrade}</span>
          )}
          {demo.resilienceScore != null && (
            <span className="text-zinc-500">· {demo.resilienceScore}/100</span>
          )}
        </div>
        <span className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-700 group-hover:text-zinc-900">
          Replay <ArrowRight className="h-3.5 w-3.5" />
        </span>
      </div>
    </Link>
  );
}
