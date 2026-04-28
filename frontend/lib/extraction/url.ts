/**
 * Generic URL → text fetcher. Dispatches to:
 *   - GitHub fetcher (single file or repo tree)
 *   - PDF binary fetch + pdfjs
 *   - Plain-text fetch (.md, .txt, etc.)
 *
 * Returns the same shape regardless of source so the orchestrator can stay
 * agnostic.
 */

import { extractPdfText } from "./pdf";
import { parseGithubUrl, fetchFromGithub, type GithubFetchResult } from "./github";

const MAX_FETCH_BYTES = 15 * 1024 * 1024; // 15 MB hard cap on a single resource
const MAX_TEXT_CHARS = 600_000;
const FETCH_TIMEOUT_MS = 30_000;

export interface UrlFetchResult {
  text: string;
  /** Human-readable origin label, used in the LLM prompt. */
  label: string;
  kind: "github-file" | "github-repo" | "pdf" | "text";
  /** For GitHub repo fetches, list the files we read. */
  filesUsed?: { path: string; bytes: number }[];
  truncated: boolean;
}

export async function fetchTextFromUrl(rawUrl: string): Promise<UrlFetchResult> {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error("empty url");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported protocol: ${url.protocol}`);
  }

  const gh = parseGithubUrl(url.toString());
  if (gh) {
    const result = await fetchFromGithub(gh);
    return githubToFetchResult(result, gh.kind === "repo" ? "github-repo" : "github-file");
  }

  // Generic fetch path. Use a HEAD-style branch on file extension as a hint,
  // but fall back to inspecting Content-Type from the actual GET.
  const looksPdf = /\.pdf(\?|#|$)/i.test(url.pathname);
  return fetchGenericResource(url, looksPdf);
}

function githubToFetchResult(
  gh: GithubFetchResult,
  kind: "github-file" | "github-repo",
): UrlFetchResult {
  const label =
    kind === "github-file"
      ? `github.com/${gh.source.owner}/${gh.source.repo}@${gh.source.ref} — ${gh.filesUsed[0]?.path ?? "file"}`
      : `github.com/${gh.source.owner}/${gh.source.repo}@${gh.source.ref} — ${gh.filesUsed.length} doc file(s)`;
  return {
    text: gh.text.slice(0, MAX_TEXT_CHARS),
    label,
    kind,
    filesUsed: gh.filesUsed,
    truncated: gh.truncated || gh.text.length > MAX_TEXT_CHARS,
  };
}

async function fetchGenericResource(url: URL, looksPdf: boolean): Promise<UrlFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "sim-wars-extractor", Accept: looksPdf ? "application/pdf,*/*" : "text/markdown,text/plain,*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (err) {
    throw new Error(`fetch failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`fetch ${res.status} ${res.statusText} for ${url}`);

  const contentLength = Number(res.headers.get("content-length") ?? "0");
  if (contentLength > MAX_FETCH_BYTES) {
    throw new Error(`resource too large (${contentLength} bytes, max ${MAX_FETCH_BYTES})`);
  }
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const isPdf = contentType.includes("application/pdf") || looksPdf;

  if (isPdf) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_FETCH_BYTES) {
      throw new Error(`pdf too large (${buf.byteLength} bytes)`);
    }
    const result = await extractPdfText(buf);
    return {
      text: result.text.slice(0, MAX_TEXT_CHARS),
      label: `${url.toString()} (pdf, ${result.pageCount} pages)`,
      kind: "pdf",
      truncated: result.truncated || result.text.length > MAX_TEXT_CHARS,
    };
  }

  const text = await res.text();
  return {
    text: text.slice(0, MAX_TEXT_CHARS),
    label: url.toString(),
    kind: "text",
    truncated: text.length > MAX_TEXT_CHARS,
  };
}
