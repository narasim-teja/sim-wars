import { NextRequest } from "next/server";
import { extractFromSource, type ExtractionOutcome } from "@/lib/extraction/extract";

/**
 * POST /api/extract/source
 *
 * Two content types:
 *   - multipart/form-data with field "file" — PDF upload
 *   - application/json with { url: string } — link paste (GitHub or generic)
 *
 * Returns the same JSON shape regardless: ExtractionOutcome.
 */

// pdfjs needs the Node runtime (uses Buffer-ish APIs, not Edge-compatible).
export const runtime = "nodejs";
// Streaming response not currently used, but mark dynamic so Next doesn't try
// to cache POST handlers with form data.
export const dynamic = "force-dynamic";

const MAX_PDF_BYTES = 15 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      return await handleUrl(req);
    }
    if (contentType.includes("multipart/form-data")) {
      return await handleFile(req);
    }
    return badRequest(`unsupported content-type: ${contentType}`);
  } catch (err) {
    const message = (err as Error).message;
    console.error("[extract] failed:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}

async function handleUrl(req: NextRequest): Promise<Response> {
  let body: { url?: unknown };
  try {
    body = (await req.json()) as { url?: unknown };
  } catch {
    return badRequest("invalid JSON body");
  }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) return badRequest("body.url is required");

  const outcome = await extractFromSource({ kind: "url", url }, { signal: req.signal });
  return ok(outcome);
}

async function handleFile(req: NextRequest): Promise<Response> {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    return badRequest(`invalid multipart body: ${(err as Error).message}`);
  }
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return badRequest("body.file is required (multipart field 'file')");
  }
  if (file.size === 0) return badRequest("uploaded file is empty");
  if (file.size > MAX_PDF_BYTES) {
    return badRequest(`file too large (${file.size} bytes, max ${MAX_PDF_BYTES})`);
  }
  if (!isLikelyPdf(file)) {
    return badRequest(`only PDF uploads are supported (got ${file.type || "unknown type"})`);
  }

  const buffer = new Uint8Array(await file.arrayBuffer());
  const outcome = await extractFromSource(
    { kind: "pdf", buffer, filename: file.name || undefined },
    { signal: req.signal },
  );
  return ok(outcome);
}

function isLikelyPdf(file: File): boolean {
  if (file.type === "application/pdf") return true;
  if (/\.pdf$/i.test(file.name)) return true;
  return false;
}

function ok(outcome: ExtractionOutcome): Response {
  return Response.json(outcome);
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}
