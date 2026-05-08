import { TopNav } from "@/components/TopNav";
import { HeroIllustration } from "@/components/HeroIllustration";
import { ReplayCards } from "@/components/ReplayCards";
import { listDemos, type DemoCard } from "@/lib/api";
import { MAX_AGENTS } from "@/lib/roster";
import { ArrowDown } from "lucide-react";
import HomeClient from "./HomeClient";

// Re-fetch demos on every request — the set is baked in at image build
// time but we don't cache to keep dev iteration honest. In dev the API
// may be unreachable; fail soft to an empty list so the page still renders.
export const dynamic = "force-dynamic";

async function fetchDemosSafe(): Promise<DemoCard[]> {
  try {
    return await listDemos();
  } catch (e) {
    // Surface so the cause is visible in CloudWatch instead of silently
    // rendering an empty replays section. (This is what hid the v1.0 prod
    // bug where API_BASE="" produced unparseable relative URLs in RSC.)
    console.error("[home page] listDemos failed:", e);
    return [];
  }
}

export default async function Home() {
  const demos = await fetchDemosSafe();
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <TopNav />
      <Hero />
      <ReplayCards demos={demos} />
      <HomeClient />
      <Footer />
    </div>
  );
}

function Hero() {
  return (
    <section className="relative px-6 py-14 sm:py-20">
      <div className="mx-auto grid w-full max-w-7xl items-center gap-10 lg:grid-cols-[1fr_minmax(0,520px)]">
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
            <span>An adversarial swarm engine</span>
          </div>
          <h1 className="text-[44px] font-semibold leading-[1.05] tracking-tight text-zinc-900 sm:text-[56px]">
            Upload your tokenomics.
            <br />
            <span className="text-zinc-400">Stress-test the future.</span>
          </h1>
          <p className="max-w-xl text-[15px] leading-7 text-zinc-600">
            Drop a whitepaper or a pre-built scenario. Sim Wars spawns up to{" "}
            <em className="font-semibold not-italic text-zinc-900">
              {MAX_AGENTS.toLocaleString()} LLM-powered adversaries
            </em>
            : whales, governance attackers, MEV bots, sybil swarms. They attack your design
            until it survives, or speedruns a death spiral.
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
  );
}

function Footer() {
  return (
    <footer className="border-t border-zinc-200 px-6 py-6">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
        <span>SIMWARS · MIT license · 2026</span>
        <span>Solana devnet · Bun · Anchor 1.0</span>
      </div>
    </footer>
  );
}
