"use client";

import { useState } from "react";
import { Pause, Play } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { ACTION_COLORS, AGENT_COLORS, agentTypeFromId } from "@/lib/agent-colors";
import type { FeedEntry } from "@/lib/types";

export function AgentFeed({ feed, onSelect }: { feed: FeedEntry[]; onSelect: (id: string) => void }) {
  const [pinned, setPinned] = useState<FeedEntry[] | null>(null);
  const items = pinned ?? feed;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
          live · {feed.length} actions
        </div>
        <button
          onClick={() => setPinned(pinned ? null : [...feed])}
          className="flex items-center gap-1 rounded border border-zinc-200 bg-white px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-600 hover:border-zinc-400"
        >
          {pinned ? (
            <>
              <Play className="h-3 w-3" /> resume
            </>
          ) : (
            <>
              <Pause className="h-3 w-3" /> pause
            </>
          )}
        </button>
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="grid h-full min-h-32 place-items-center font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-400">
            waiting for first action…
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {items.slice(0, 80).map((f) => {
              const t = agentTypeFromId(f.agentId);
              return (
                <motion.div
                  key={f.id}
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  onClick={() => onSelect(f.agentId)}
                  className="cursor-pointer border-b border-zinc-100 px-3 py-2 last:border-0 hover:bg-zinc-50"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: AGENT_COLORS[t] }}
                    />
                    <span className="font-mono text-[12px] font-semibold text-zinc-900">{f.agentId}</span>
                    <span
                      className="ml-auto rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-white"
                      style={{ background: ACTION_COLORS[f.action] }}
                    >
                      {f.action}
                    </span>
                    <span className="font-mono text-[10px] text-zinc-500 tabular-nums">t{f.tick}</span>
                  </div>
                  {f.amount != null && (
                    <div className="mt-1 pl-4 font-mono text-[11px] text-zinc-600 tabular-nums">
                      amount {f.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </div>
                  )}
                  {f.reasoning && (
                    <p className="mt-1 pl-4 text-[11px] italic leading-5 text-zinc-500 line-clamp-2">
                      &ldquo;{f.reasoning}&rdquo;
                    </p>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
