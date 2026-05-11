import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { SiteFooter } from "@/components/SiteFooter";
import { listDemos, apiBase } from "@/lib/api";
import { ArrowRight, Skull, ShieldCheck } from "lucide-react";

// This page reads `/api/demos` server-side at request time. `apiBase()`
// resolves to the loopback API in RSC context (same in dev and prod),
// so the fetch works without per-environment configuration.
export const dynamic = "force-dynamic";

async function fetchDemos() {
  try {
    return await listDemos();
  } catch (e) {
    // Surface failures to the server log — masking them silently is what
    // hid the prod demos breakage in v1.0.
    console.error("[demos page] listDemos failed:", e);
    return [];
  }
}

export default async function DemosPage() {
  const demos = await fetchDemos();

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <TopNav />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-12">
        <header className="flex flex-col gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
            replayable recordings
          </span>
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">
            Pre-recorded simulation demos
          </h1>
          <p className="max-w-2xl text-[14px] leading-relaxed text-zinc-600">
            Each card opens a full replay: token price, agent feed, governance traffic, on-chain
            transactions, and the post-sim resilience report. No API key needed. Demos are
            pre-recorded event streams baked into the image.
          </p>
          <p className="text-[12px] text-zinc-500">
            Want to run your own protocol?{" "}
            <Link href="/" className="underline-offset-2 hover:underline">
              Bring an OpenRouter key
            </Link>{" "}
            and launch a custom sim.
          </p>
        </header>

        {demos.length === 0 ? (
          <div className="grid h-64 place-items-center rounded-md border border-dashed border-zinc-200 font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-400">
            no demos found · check API at {apiBase() || "/api/demos"}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {demos.map((d) => (
              <Link
                key={d.simId}
                href={`/simulate/${d.simId}`}
                className="group flex flex-col gap-3 rounded-md border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-900 hover:bg-zinc-50/40"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                    {d.simId.slice(0, 8)}
                  </span>
                  <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                    {d.totalTicks} ticks
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  {d.deathSpiralDetected ? (
                    <Skull className="mt-1 h-4 w-4 shrink-0 text-red-700" />
                  ) : (
                    <ShieldCheck className="mt-1 h-4 w-4 shrink-0 text-emerald-700" />
                  )}
                  <h2 className="text-[18px] font-semibold leading-snug text-zinc-900">
                    {d.name}
                  </h2>
                </div>
                <p className="text-[13px] leading-relaxed text-zinc-600">{d.description}</p>
                <div className="mt-auto flex items-center justify-between border-t border-zinc-100 pt-3">
                  <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em]">
                    {d.resilienceGrade && (
                      <span
                        className={
                          d.deathSpiralDetected
                            ? "text-red-700"
                            : "text-emerald-700"
                        }
                      >
                        grade {d.resilienceGrade}
                      </span>
                    )}
                    {d.resilienceScore != null && (
                      <span className="text-zinc-500">· {d.resilienceScore}/100</span>
                    )}
                  </div>
                  <span className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-700 group-hover:text-zinc-900">
                    Replay <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
