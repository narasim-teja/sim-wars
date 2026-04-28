/**
 * Client-side helpers for /api/extract/source. Do not import from any module
 * that pulls in pdfjs / openrouter — those are server-only.
 */

import type { ExtractionOutcome } from "./extraction/types";

export async function extractFromUrl(
  url: string,
  signal?: AbortSignal,
): Promise<ExtractionOutcome> {
  const res = await fetch("/api/extract/source", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    signal,
  });
  return parseResponse(res);
}

export async function extractFromFile(
  file: File,
  signal?: AbortSignal,
): Promise<ExtractionOutcome> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/extract/source", {
    method: "POST",
    body: fd,
    signal,
  });
  return parseResponse(res);
}

async function parseResponse(res: Response): Promise<ExtractionOutcome> {
  if (!res.ok) {
    let detail = "";
    try {
      const data = (await res.json()) as { error?: string };
      detail = data.error ?? "";
    } catch {
      detail = await res.text();
    }
    throw new Error(detail || `extract failed (${res.status})`);
  }
  return (await res.json()) as ExtractionOutcome;
}
