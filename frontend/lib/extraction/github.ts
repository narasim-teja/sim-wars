/**
 * GitHub URL handling for whitepaper extraction.
 *
 * Two flavors of input:
 *   - A specific file URL (`/blob/<branch>/<path>`, raw.githubusercontent.com,
 *     a `.pdf` link in the repo) → fetch that one file.
 *   - A repo root URL (`github.com/owner/repo` or `.../tree/<branch>`)
 *     → walk the repo tree, pick documentation files, concat.
 *
 * Public repos only. Private support is out of scope for the demo.
 *
 * Optional GITHUB_TOKEN bumps the rate limit from 60/hr to 5000/hr.
 */

import { extractPdfText } from "./pdf";

const GH_API = "https://api.github.com";
const MAX_FILES = 6;
const MAX_TOTAL_CHARS = 600_000;
const MAX_FILE_BYTES = 1_500_000;

const DOC_NAME_REGEX = /(whitepaper|tokenomics|economics|paper|spec|tokens?|distribution)/i;
const DOC_EXT_REGEX = /\.(md|markdown|mdx|txt|rst|pdf)$/i;

export interface GithubFetchResult {
  /** Concatenated text from selected files. */
  text: string;
  /** Files we actually pulled, in order. */
  filesUsed: { path: string; bytes: number }[];
  /** Owner/repo/ref so the UI can show what we read. */
  source: { owner: string; repo: string; ref: string; kind: "file" | "repo" };
  truncated: boolean;
}

interface ParsedUrl {
  kind: "file" | "repo" | "raw";
  owner: string;
  repo: string;
  ref?: string;
  path?: string;
}

/**
 * Try to parse a GitHub URL into something we can act on. Returns null for
 * non-GitHub URLs.
 */
export function parseGithubUrl(input: string): ParsedUrl | null {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split("/").filter(Boolean);

  // raw.githubusercontent.com/<owner>/<repo>/<ref>/<path...>
  if (host === "raw.githubusercontent.com") {
    if (segs.length < 4) return null;
    const [owner, repo, ref, ...rest] = segs;
    return { kind: "raw", owner, repo, ref, path: rest.join("/") };
  }

  if (host !== "github.com" && host !== "www.github.com") return null;

  if (segs.length < 2) return null;
  const [owner, repo, action, ...rest] = segs;

  // github.com/owner/repo
  if (!action) return { kind: "repo", owner, repo: stripDotGit(repo) };

  // github.com/owner/repo/blob/<ref>/<path>
  if (action === "blob" && rest.length >= 2) {
    const [ref, ...pathParts] = rest;
    return { kind: "file", owner, repo: stripDotGit(repo), ref, path: pathParts.join("/") };
  }

  // github.com/owner/repo/tree/<ref>[/<subpath>]
  if (action === "tree" && rest.length >= 1) {
    return { kind: "repo", owner, repo: stripDotGit(repo), ref: rest[0] };
  }

  // github.com/owner/repo/raw/<ref>/<path>  (older redirect form)
  if (action === "raw" && rest.length >= 2) {
    const [ref, ...pathParts] = rest;
    return { kind: "file", owner, repo: stripDotGit(repo), ref, path: pathParts.join("/") };
  }

  // Fallback: treat anything else as repo root
  return { kind: "repo", owner, repo: stripDotGit(repo) };
}

function stripDotGit(s: string): string {
  return s.endsWith(".git") ? s.slice(0, -4) : s;
}

function ghHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "sim-wars-extractor",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function fetchFromGithub(parsed: ParsedUrl): Promise<GithubFetchResult> {
  if (parsed.kind === "file" || parsed.kind === "raw") {
    return fetchSingleFile(parsed);
  }
  return fetchRepoDocs(parsed);
}

async function fetchSingleFile(parsed: ParsedUrl): Promise<GithubFetchResult> {
  if (!parsed.path) throw new Error("github file URL missing path");
  const ref = parsed.ref ?? (await defaultBranch(parsed.owner, parsed.repo));
  const text = await fetchRawFileText(parsed.owner, parsed.repo, ref, parsed.path);
  return {
    text,
    filesUsed: [{ path: parsed.path, bytes: text.length }],
    source: { owner: parsed.owner, repo: parsed.repo, ref, kind: "file" },
    truncated: false,
  };
}

async function fetchRepoDocs(parsed: ParsedUrl): Promise<GithubFetchResult> {
  const ref = parsed.ref ?? (await defaultBranch(parsed.owner, parsed.repo));
  const tree = await fetchTree(parsed.owner, parsed.repo, ref);

  const ranked = tree
    .filter((e) => e.type === "blob")
    .filter((e) => DOC_EXT_REGEX.test(e.path))
    .filter((e) => e.size <= MAX_FILE_BYTES)
    .map((e) => ({ ...e, score: scorePath(e.path) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FILES);

  if (ranked.length === 0) {
    throw new Error(
      `no documentation files found in ${parsed.owner}/${parsed.repo}@${ref} ` +
        `(looked for whitepaper/tokenomics/spec/README in .md/.txt/.pdf)`,
    );
  }

  const parts: string[] = [];
  const filesUsed: { path: string; bytes: number }[] = [];
  let total = 0;
  let truncated = false;

  for (const entry of ranked) {
    try {
      const text = await fetchRawFileText(parsed.owner, parsed.repo, ref, entry.path);
      const remaining = MAX_TOTAL_CHARS - total;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const chunk = text.slice(0, remaining);
      parts.push(`=== file: ${entry.path} ===\n\n${chunk}`);
      filesUsed.push({ path: entry.path, bytes: chunk.length });
      total += chunk.length + 32;
      if (chunk.length < text.length) truncated = true;
    } catch (err) {
      // skip an unreadable file rather than failing the whole extraction
      console.warn(`[github] skipping ${entry.path}:`, (err as Error).message);
    }
  }

  return {
    text: parts.join("\n\n"),
    filesUsed,
    source: { owner: parsed.owner, repo: parsed.repo, ref, kind: "repo" },
    truncated,
  };
}

/**
 * Filename → relevance score for documentation extraction.
 * Higher = more likely to contain tokenomics. Zero = skip.
 */
function scorePath(path: string): number {
  const name = path.split("/").pop() ?? path;
  const lower = path.toLowerCase();

  let score = 0;
  if (DOC_NAME_REGEX.test(name)) score += 10;
  if (/^readme\./i.test(name)) score += 4;
  if (lower.startsWith("docs/") || lower.includes("/docs/")) score += 3;
  if (/\.pdf$/i.test(name)) score += 6; // whitepapers are usually PDFs
  if (/changelog|license|contributing|code_of_conduct/i.test(name)) score = 0;
  if (/node_modules|\.git\//.test(lower)) score = 0;
  return score;
}

async function defaultBranch(owner: string, repo: string): Promise<string> {
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}`, { headers: ghHeaders() });
  if (!res.ok) {
    throw new Error(`github ${res.status}: cannot read ${owner}/${repo} (private or missing?)`);
  }
  const data = (await res.json()) as { default_branch?: string };
  return data.default_branch ?? "main";
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size: number;
}

async function fetchTree(owner: string, repo: string, ref: string): Promise<TreeEntry[]> {
  const url = `${GH_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`github ${res.status}: tree ${owner}/${repo}@${ref}`);
  const data = (await res.json()) as { tree?: { path: string; type: string; size?: number }[]; truncated?: boolean };
  return (data.tree ?? []).map((t) => ({
    path: t.path,
    type: (t.type as TreeEntry["type"]) ?? "blob",
    size: t.size ?? 0,
  }));
}

async function fetchRawFileText(owner: string, repo: string, ref: string, path: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const res = await fetch(url, {
    headers: process.env.GITHUB_TOKEN
      ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : undefined,
  });
  if (!res.ok) throw new Error(`raw ${res.status}: ${path}`);
  if (/\.pdf$/i.test(path)) {
    const buf = new Uint8Array(await res.arrayBuffer());
    const result = await extractPdfText(buf);
    return result.text;
  }
  return await res.text();
}
