import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { SiteFooter } from "@/components/SiteFooter";
import { ShieldCheck, KeyRound, ArrowUpRight, Database, Cpu } from "lucide-react";

const GIT_SHA = process.env.NEXT_PUBLIC_GIT_SHA?.slice(0, 7) ?? "dev";
const IMAGE_DIGEST = process.env.NEXT_PUBLIC_IMAGE_DIGEST?.slice(0, 16) ?? null;
const REPO_URL = "https://github.com/narasim-teja/sim-wars";

export default function AboutPage() {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <TopNav />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12">
        <header className="flex flex-col gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
            what this is · how it works
          </span>
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">About SIMWARS</h1>
          <p className="text-[14px] leading-relaxed text-zinc-600">
            Bad tokenomics kills more crypto projects than bad code. SimWars is an attempt to
            change that: a swarm of language-model agents that role-play the worst actors in a
            token economy and stress-test your design before users do.
          </p>
        </header>

        <Section icon={<Cpu className="h-4 w-4" />} title="What's happening under the hood">
          <p>
            Every simulation runs a roster of adversaries against your tokenomics, tick by tick.
            Whales accumulate and dump. Governance attackers buy voting power and submit
            self-serving proposals. MEV bots front-run. Sybil rings coordinate. Each agent gets the
            live state every tick (price, supply, staking ratio, open proposals, balances) and
            decides what to do on its own.
          </p>
          <p>
            What you see at the end is a resilience report: where the design held, where it broke,
            which agent triggered it, and what you could change before launch.
          </p>
        </Section>

        <Section icon={<KeyRound className="h-4 w-4" />} title="Bring your own key">
          <p>
            Agents call language models through OpenRouter. We don&apos;t run a shared key and we
            don&apos;t bill you. Paste your own key into the launcher and it&apos;s held in browser
            memory, or in <code className="rounded bg-zinc-100 px-1">localStorage</code> if you
            tick &ldquo;remember on this device.&rdquo;
          </p>
          <p>
            From there it travels over HTTPS to the API and is handed directly to the worker
            process that runs your sim, via an environment variable. It isn&apos;t written to any
            log line or stored alongside the run. The demo replays on this site never hit a model
            at all, they&apos;re pre-recorded event streams.
          </p>
        </Section>

        <Section icon={<ShieldCheck className="h-4 w-4" />} title="What we don't do with your key">
          <ul className="list-disc space-y-1 pl-5 marker:text-zinc-400">
            <li>It&apos;s never written to disk or any log line.</li>
            <li>It&apos;s scoped to one worker process and dies with it when the run ends.</li>
            <li>The site is served over HTTPS in production.</li>
            <li>
              All of this is open source. If you want to verify any of it, the build running here is
              commit{" "}
              <a
                className="underline-offset-2 hover:underline"
                href={`${REPO_URL}/commit/${GIT_SHA}`}
              >
                {GIT_SHA}
              </a>
              .
            </li>
          </ul>
        </Section>

        <Section icon={<Database className="h-4 w-4" />} title="Provenance">
          <Stat label="git sha" value={GIT_SHA} />
          {IMAGE_DIGEST && <Stat label="image digest" value={IMAGE_DIGEST} />}
          <Stat label="region" value="us-east-1 (AWS)" />
          <p className="pt-2">
            <Link
              href={REPO_URL}
              className="inline-flex items-center gap-1.5 text-zinc-700 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
              {REPO_URL.replace("https://", "")}
            </Link>
          </p>
        </Section>
      </main>
      <SiteFooter />
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-md border border-zinc-200 bg-white p-5">
      <header className="flex items-center gap-2">
        <span className="text-zinc-700">{icon}</span>
        <h2 className="text-[15px] font-semibold text-zinc-900">{title}</h2>
      </header>
      <div className="flex flex-col gap-2 text-[13.5px] leading-relaxed text-zinc-700">
        {children}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-zinc-100 py-1.5 last:border-b-0">
      <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
        {label}
      </span>
      <span className="font-mono text-[12px] tabular-nums text-zinc-900">{value}</span>
    </div>
  );
}
