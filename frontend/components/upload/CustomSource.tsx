"use client";

import { useCallback, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { FileText, GitBranch, Link2, Loader2, Upload, X } from "lucide-react";
import type { ExtractionOutcome } from "@/lib/extraction/types";
import { extractFromFile, extractFromUrl } from "@/lib/extraction-client";
import { cn } from "@/lib/utils";

type State =
  | { kind: "idle" }
  | { kind: "staged-file"; file: File }
  | { kind: "extracting"; sourceLabel: string }
  | { kind: "ready"; outcome: ExtractionOutcome }
  | { kind: "error"; message: string };

export interface CustomSourceProps {
  /** Fires when extraction succeeds. Parent owns the resulting config. */
  onExtracted: (outcome: ExtractionOutcome) => void;
  /** Fires when the user clears their custom source. */
  onCleared: () => void;
}

export function CustomSource({ onExtracted, onCleared }: CustomSourceProps) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [urlInput, setUrlInput] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const startExtraction = useCallback(
    async (sourceLabel: string, runner: (signal: AbortSignal) => Promise<ExtractionOutcome>) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setState({ kind: "extracting", sourceLabel });
      try {
        const outcome = await runner(ctrl.signal);
        if (ctrl.signal.aborted) return;
        setState({ kind: "ready", outcome });
        onExtracted(outcome);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setState({ kind: "error", message: (err as Error).message });
      }
    },
    [onExtracted],
  );

  const onDrop = useCallback((accepted: File[]) => {
    const file = accepted[0];
    if (!file) return;
    // Stage the file; the user clicks "Extract" to fire the API call.
    setState({ kind: "staged-file", file });
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
    maxSize: 15 * 1024 * 1024,
    disabled: state.kind === "extracting",
  });

  const extractStagedFile = useCallback(() => {
    if (state.kind !== "staged-file") return;
    const file = state.file;
    void startExtraction(file.name, (signal) => extractFromFile(file, signal));
  }, [state, startExtraction]);

  const submitUrl = useCallback(() => {
    const url = urlInput.trim();
    if (!url) return;
    void startExtraction(url, (signal) => extractFromUrl(url, signal));
  }, [urlInput, startExtraction]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setUrlInput("");
    setState({ kind: "idle" });
    onCleared();
  }, [onCleared]);

  if (state.kind === "extracting") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-zinc-200 bg-white p-5">
        <div className="flex items-center gap-3 text-zinc-700">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="font-mono text-[12px] uppercase tracking-[0.2em]">extracting…</span>
        </div>
        <p className="truncate font-mono text-[11px] text-zinc-500">{state.sourceLabel}</p>
        <p className="text-[12px] text-zinc-500">
          Reading source · running OpenRouter preset · validating JSON. Usually 5–20 seconds for a
          full whitepaper.
        </p>
        <button
          onClick={reset}
          className="mt-2 w-fit cursor-pointer font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500 hover:text-zinc-900"
        >
          cancel
        </button>
      </div>
    );
  }

  if (state.kind === "ready") {
    return (
      <ReadyCard outcome={state.outcome} onReset={reset} />
    );
  }

  if (state.kind === "staged-file") {
    return (
      <div className="flex flex-col gap-3 rounded-md border border-zinc-300 bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-600">
              <FileText className="h-3.5 w-3.5" />
              ready to extract
            </div>
            <div className="truncate text-[14px] font-semibold text-zinc-900">
              {state.file.name}
            </div>
            <div className="font-mono text-[11px] text-zinc-500">
              {(state.file.size / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 })} KB
            </div>
          </div>
          <button
            onClick={reset}
            aria-label="Remove file"
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="text-[12px] leading-5 text-zinc-500">
          Extraction calls OpenRouter to parse the whitepaper. Usually 5–20 seconds.
        </p>
        <button
          onClick={extractStagedFile}
          className="h-10 cursor-pointer rounded bg-zinc-900 font-mono text-[11px] uppercase tracking-[0.22em] text-white hover:bg-zinc-800"
        >
          Extract tokenomics
        </button>
      </div>
    );
  }

  // idle or error
  return (
    <div className="flex flex-col gap-3">
      <div
        {...getRootProps()}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed bg-white px-6 py-10 text-center transition-colors",
          isDragActive ? "border-zinc-900 bg-zinc-50" : "border-zinc-300 hover:border-zinc-500",
        )}
      >
        <input {...getInputProps()} />
        <Upload className="h-5 w-5 text-zinc-500" />
        <div className="font-mono text-[12px] uppercase tracking-[0.2em] text-zinc-700">
          {isDragActive ? "drop pdf to extract" : "drop a whitepaper pdf"}
        </div>
        <div className="font-mono text-[10px] tracking-[0.2em] text-zinc-400">
          or click to browse · max 15 MB
        </div>
      </div>

      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-400">
        <span className="h-px flex-1 bg-zinc-200" />
        or paste a link
        <span className="h-px flex-1 bg-zinc-200" />
      </div>

      <div className="flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 focus-within:border-zinc-900">
        <Link2 className="h-3.5 w-3.5 text-zinc-400" />
        <input
          type="url"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitUrl();
            }
          }}
          placeholder="github.com/owner/repo · raw .md · pdf url"
          className="h-10 flex-1 bg-transparent font-mono text-[12px] text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
        />
        <button
          onClick={submitUrl}
          disabled={!urlInput.trim()}
          className="h-7 cursor-pointer rounded bg-zinc-900 px-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          extract
        </button>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] tracking-[0.18em] text-zinc-400">
        <span className="inline-flex items-center gap-1">
          <GitBranch className="h-3 w-3" /> github repo or file URL
        </span>
        <span>·</span>
        <span className="inline-flex items-center gap-1">
          <FileText className="h-3 w-3" /> raw .md / .txt
        </span>
        <span>·</span>
        <span>direct .pdf link</span>
      </div>

      {state.kind === "error" && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700">
          {state.message}
        </div>
      )}
    </div>
  );
}

function ReadyCard({
  outcome,
  onReset,
}: {
  outcome: ExtractionOutcome;
  onReset: () => void;
}) {
  const filledCount = outcome.extractedFields.length;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-emerald-200 bg-emerald-50/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-emerald-700">
            <span className="block h-2 w-2 rounded-full bg-emerald-600" />
            extracted
          </div>
          <div className="text-base font-semibold text-zinc-900">
            {outcome.protocolName ?? "Custom protocol"}
          </div>
          <div className="font-mono text-[11px] text-zinc-500 break-all">
            {outcome.source.label}
          </div>
        </div>
        <button
          onClick={onReset}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          aria-label="Clear extraction"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
        {outcome.protocolKind && <span>kind: {outcome.protocolKind}</span>}
        <span>fields: {filledCount}</span>
        {typeof outcome.confidence === "number" && (
          <span>confidence: {(outcome.confidence * 100).toFixed(0)}%</span>
        )}
        <span className="truncate">model: {outcome.model}</span>
        {outcome.source.truncated && <span className="text-amber-700">source truncated</span>}
      </div>

      {outcome.notes && (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          {outcome.notes}
        </p>
      )}

      {outcome.source.filesUsed && outcome.source.filesUsed.length > 0 && (
        <details className="rounded border border-zinc-200 bg-white">
          <summary className="cursor-pointer px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
            {outcome.source.filesUsed.length} file(s) read
          </summary>
          <ul className="border-t border-zinc-100 px-3 py-2 font-mono text-[11px] text-zinc-600">
            {outcome.source.filesUsed.map((f) => (
              <li key={f.path} className="truncate">
                · {f.path}{" "}
                <span className="text-zinc-400">({f.bytes.toLocaleString()} chars)</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
