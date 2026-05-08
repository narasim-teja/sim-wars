"use client";

import { useState } from "react";
import { ExternalLink, Eye, EyeOff, KeyRound, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { setStoredCredential, validateCredential } from "@/lib/byok";
import { cn } from "@/lib/utils";

interface ByokDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the validated key once the user clicks "Use this key". */
  onSubmit: (key: string) => void;
  /** Pre-fill the input (e.g. when re-opening with a previously-stored key). */
  initialKey?: string;
}

export function ByokDialog({ open, onOpenChange, onSubmit, initialKey }: ByokDialogProps) {
  const [key, setKey] = useState(initialKey ?? "");
  const [reveal, setReveal] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = key.trim();
    if (!validateCredential("openrouter", trimmed)) {
      setError("That doesn't look like an OpenRouter key. Expected a string starting with sk-or-…");
      return;
    }
    setStoredCredential("openrouter", trimmed, { remember });
    setError(null);
    onSubmit(trimmed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            Bring your own OpenRouter key
          </DialogTitle>
          <DialogDescription>
            Live simulations call OpenRouter to drive the agents. Demo runs are pre-recorded
            and don&apos;t need a key.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 text-[12.5px] leading-relaxed text-zinc-700">
          <div className="flex items-start gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
            <div>
              <p className="font-medium text-emerald-900">Your key never lands on disk.</p>
              <p className="text-emerald-800">
                It&apos;s held in memory, forwarded to the worker process for the duration of
                the run, and discarded when the run ends. Open-source &mdash; verify in the repo.
              </p>
            </div>
          </div>

          <div className="grid gap-1.5">
            <label className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
              OpenRouter key
            </label>
            <div className="flex items-center gap-2 rounded border border-zinc-200 bg-white px-2 py-1.5 focus-within:border-zinc-400">
              <input
                type={reveal ? "text" : "password"}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setError(null);
                }}
                placeholder="sk-or-v1-…"
                spellCheck={false}
                autoComplete="off"
                className="flex-1 bg-transparent font-mono text-[12px] tabular-nums text-zinc-900 outline-none placeholder:text-zinc-400"
              />
              <button
                type="button"
                onClick={() => setReveal((v) => !v)}
                className="text-zinc-500 hover:text-zinc-900"
                aria-label={reveal ? "hide key" : "show key"}
              >
                {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            {error && <p className="font-mono text-[11px] text-red-700">{error}</p>}
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-fit items-center gap-1 text-[11px] text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              Don&apos;t have one? Mint a key on openrouter.ai
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          <label
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded border px-3 py-2",
              remember
                ? "border-zinc-900 bg-zinc-50"
                : "border-zinc-200 bg-white hover:border-zinc-300",
            )}
          >
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            <span className="text-[12px] text-zinc-800">
              Remember on this device (saves to <code className="rounded bg-zinc-100 px-1">localStorage</code>{" "}
              &mdash; clear anytime)
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!key.trim()}>
            Use this key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
