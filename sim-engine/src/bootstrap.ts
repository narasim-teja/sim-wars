/**
 * Process-wide bootstrap: load env vars from the repo-root `.env` *before*
 * any module reads `process.env`.
 *
 * Why this exists: Bun auto-loads only `.env` from CWD. When the API server
 * is launched from `sim-engine/`, the repo-root `.env` (where OpenRouter keys
 * live) never gets picked up — so the worker silently fell back to local
 * Ollama in production runs. This module deterministically overlays the root
 * `.env` so it doesn't matter where you ran `bun run` from.
 *
 * Order of precedence (highest wins):
 *   1. existing process.env (CI / shell exports)
 *   2. sim-engine/.env (Bun auto-load)
 *   3. <repo-root>/.env (this module)
 *
 * Import this at the very top of every entry-point script
 * (`api/server.ts`, `worker/main.ts`, `index.ts`, scripts/*).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf-8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
loadEnvFile(resolve(REPO_ROOT, ".env"));

/** Hard-fail with a clear message if a required env var is missing. */
export function requireEnv(name: string, hint?: string): string {
  const v = process.env[name];
  if (!v) {
    const msg = hint
      ? `missing required env var ${name}. ${hint}`
      : `missing required env var ${name}`;
    throw new Error(msg);
  }
  return v;
}
