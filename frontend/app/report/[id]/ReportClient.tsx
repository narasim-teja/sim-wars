"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, ArrowLeft } from "lucide-react";
import { fetchReport, type SimulationReport } from "@/lib/report";
import { ReportPanel } from "@/components/report/ReportPanel";

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 60; // ~3 minutes

export function ReportClient({ simId }: { simId: string }) {
  const [report, setReport] = useState<SimulationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let count = 0;

    async function poll() {
      try {
        const r = await fetchReport(simId);
        if (cancelled) return;
        if (r) {
          setReport(r);
          return;
        }
        count++;
        setAttempts(count);
        if (count >= POLL_MAX_ATTEMPTS) {
          setError("Report not ready after 3 minutes — sim may still be running, or it failed before generating one.");
          return;
        }
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [simId]);

  const shareUrl = typeof window !== "undefined" ? window.location.href : undefined;

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white p-8">
        <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-red-700">report unavailable</div>
        <p className="max-w-md text-center text-[13px] text-zinc-700">{error}</p>
        <Link
          href={`/simulate/${simId}`}
          className="flex items-center gap-1.5 rounded border border-zinc-300 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-700 hover:border-zinc-900"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> back to live sim
        </Link>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-white p-8">
        <Loader2 className="h-5 w-5 animate-spin text-zinc-700" />
        <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
          waiting for report · attempt {attempts}/{POLL_MAX_ATTEMPTS}
        </div>
        <p className="max-w-md text-center text-[12px] text-zinc-500">
          The report generates automatically when the simulation finishes.
          Long sims (50+ ticks) usually take 30–90 s after the final tick.
        </p>
        <Link
          href={`/simulate/${simId}`}
          className="mt-2 flex items-center gap-1.5 rounded border border-zinc-300 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-700 hover:border-zinc-900"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> watch live sim
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <div className="border-b border-zinc-200 bg-white px-6 py-3 print:hidden">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3">
          <Link
            href={`/simulate/${simId}`}
            className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-600 hover:text-zinc-900"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> back to live dashboard
          </Link>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-400">
            sim · {simId.slice(0, 12)}
          </div>
        </div>
      </div>
      <ReportPanel report={report} shareUrl={shareUrl} />
    </div>
  );
}
