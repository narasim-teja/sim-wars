import Link from "next/link";
import { TopNav } from "@/components/TopNav";
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
            trust · architecture · provenance
          </span>
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">About SIMWARS</h1>
          <p className="text-[14px] leading-relaxed text-zinc-600">
            An adversarial swarm engine that runs LLM-driven personas against a tokenomic spec.
            Open-source — every guarantee on this page is verifiable in the repo.
          </p>
        </header>

        <Section icon={<KeyRound className="h-4 w-4" />} title="Bring your own OpenRouter key">
          <p>
            Live simulations run agents through OpenRouter. We don&apos;t bill you and we don&apos;t
            run a shared key. To start a custom sim you paste your own key into the launcher; it&apos;s
            held in browser memory (or <code className="rounded bg-zinc-100 px-1">localStorage</code>{" "}
            if you tick &ldquo;remember on this device&rdquo;).
          </p>
          <p>
            On the wire the key flows from the browser to the API server over HTTPS, then directly
            into the spawned worker subprocess via environment variables. The server&apos;s persisted{" "}
            <code className="rounded bg-zinc-100 px-1">scenario.json</code> is written without the
            key field — verified by an integration test in{" "}
            <code className="rounded bg-zinc-100 px-1">
              src/api/server.integration.test.ts
            </code>
            .
          </p>
          <p>Demo replays don&apos;t hit the LLM at all — they&apos;re NDJSON recordings.</p>
        </Section>

        <Section icon={<ShieldCheck className="h-4 w-4" />} title="Safety properties">
          <ul className="list-disc space-y-1 pl-5 marker:text-zinc-400">
            <li>HTTPS-only in production (TLS terminated by AWS App Runner).</li>
            <li>API key never written to disk or any log line.</li>
            <li>Per-process scope: key dies with the worker process.</li>
            <li>Open-source — audit the binding in commit{" "}
              <a className="underline-offset-2 hover:underline" href={`${REPO_URL}/commit/${GIT_SHA}`}>
                {GIT_SHA}
              </a>.
            </li>
          </ul>
        </Section>

        <Section icon={<Cpu className="h-4 w-4" />} title="Architecture">
          <p>
            Single Docker container running three processes: Caddy reverse-proxy on :8080, the
            sim-engine API on :8787 (Bun), and the Next.js frontend on :3000. AWS App Runner pulls
            the image from ECR and TLS-terminates at <code className="rounded bg-zinc-100 px-1">simwars.xyz</code>.
          </p>
          <p>
            Each simulation spawns a subprocess that drives a tick loop, batched LLM calls, and
            optional on-chain Solana deploys. State writes are NDJSON event-streams + SQLite per
            run, broadcast to the browser via WebSocket.
          </p>
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
      <footer className="border-t border-zinc-200 px-6 py-6">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
          <span>SIMWARS · MIT license · 2026</span>
          <Link href="/demos" className="hover:text-zinc-900">demos</Link>
        </div>
      </footer>
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
