/**
 * Top-level orchestrator: source → text → LLM (preset) → validated config.
 *
 * Three input shapes:
 *   - { kind: "pdf", buffer }
 *   - { kind: "url", url }
 *   - { kind: "text", text, label? }   (used internally; not exposed via API yet)
 *
 * Output is the same shape regardless: a fully populated SimulationConfig
 * (defaults merged) plus metadata describing what was extracted vs defaulted.
 */

import { extractPdfText } from "./pdf";
import { fetchTextFromUrl } from "./url";
import { buildExtractionUserMessage } from "./prompt";
import { callExtractionPreset } from "./openrouter";
import { ExtractionResponseSchema, parseExtractedConfig } from "./schema";
import type { ExtractionOutcome } from "./types";

export type { ExtractionOutcome } from "./types";

export type ExtractionSource =
  | { kind: "pdf"; buffer: Uint8Array; filename?: string }
  | { kind: "url"; url: string }
  | { kind: "text"; text: string; label?: string };

const MIN_USEFUL_TEXT_CHARS = 200;

export async function extractFromSource(
  source: ExtractionSource,
  opts: { signal?: AbortSignal } = {},
): Promise<ExtractionOutcome> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const preset = process.env.OPENROUTER_EXTRACTION_PRESET;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY not set in frontend/.env.local");
  }
  if (!preset) {
    throw new Error("OPENROUTER_EXTRACTION_PRESET not set in frontend/.env.local");
  }

  // 1. Source → text
  const fetched = await sourceToText(source);
  if (fetched.text.length < MIN_USEFUL_TEXT_CHARS) {
    throw new Error(
      `extracted text is too short (${fetched.text.length} chars) — source may be empty, image-only, or behind auth`,
    );
  }

  // 2. text → LLM
  const userMessage = buildExtractionUserMessage({
    sourceLabel: fetched.label,
    sourceText: fetched.text,
  });
  const call = await callExtractionPreset({
    apiKey,
    preset,
    userMessage,
    signal: opts.signal,
  });

  // 3. raw JSON → validated
  let raw: unknown;
  try {
    raw = JSON.parse(call.json);
  } catch (err) {
    throw new Error(
      `model did not return valid JSON: ${(err as Error).message} — got: ${call.json.slice(0, 200)}`,
    );
  }

  const envelope = ExtractionResponseSchema.safeParse(raw);
  if (!envelope.success) {
    throw new Error(`model JSON did not match expected envelope: ${envelope.error.message}`);
  }

  const { config, extractedFields } = parseExtractedConfig(envelope.data.config ?? {});

  return {
    config,
    extractedFields,
    protocolName: envelope.data.protocolName,
    protocolKind: envelope.data.protocolKind,
    confidence: envelope.data.confidence,
    notes: envelope.data.notes,
    source: {
      label: fetched.label,
      kind: fetched.kind,
      filesUsed: fetched.filesUsed,
      truncated: fetched.truncated,
    },
    model: call.model,
    usage: call.usage,
  };
}

interface FetchedText {
  text: string;
  label: string;
  kind: ExtractionOutcome["source"]["kind"];
  filesUsed?: { path: string; bytes: number }[];
  truncated: boolean;
}

async function sourceToText(source: ExtractionSource): Promise<FetchedText> {
  if (source.kind === "text") {
    return {
      text: source.text,
      label: source.label ?? "raw text",
      kind: "text",
      truncated: false,
    };
  }
  if (source.kind === "pdf") {
    const result = await extractPdfText(source.buffer);
    const label = source.filename ? `${source.filename} (pdf, ${result.pageCount} pages)` : `pdf (${result.pageCount} pages)`;
    return { text: result.text, label, kind: "pdf", truncated: result.truncated };
  }
  // url
  const result = await fetchTextFromUrl(source.url);
  return {
    text: result.text,
    label: result.label,
    kind: result.kind,
    filesUsed: result.filesUsed,
    truncated: result.truncated,
  };
}
