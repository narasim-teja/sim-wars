"use client";

import { useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { ACTION_COLORS, AGENT_COLORS, agentTypeFromId } from "@/lib/agent-colors";
import { Pause, Play } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { FeedEntry } from "@/lib/types";

export function AgentFeed({ feed, onSelect }: { feed: FeedEntry[]; onSelect: (id: string) => void }) {
  const [pinned, setPinned] = useState<FeedEntry[] | null>(null);
  const items = pinned ?? feed;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-2">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400" />
          live action feed · {feed.length}
        </div>
        <button
          onClick={() => setPinned(pinned ? null : [...feed])}
          className="flex items-center gap-1 rounded border border-white/5 bg-black/40 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-zinc-400 hover:border-cyan-400/40 hover:text-cyan-300"
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

      <ScrollArea className="flex-1">
        <div className="thin-scroll p-2">
          {items.length === 0 ? (
            <div className="grid h-32 place-items-center font-mono text-[10px] uppercase tracking-widest text-zinc-600">
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
                    className="cursor-pointer border-b border-white/5 px-2 py-2 last:border-0 hover:bg-white/[0.02]"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: AGENT_COLORS[t], boxShadow: `0 0 6px ${AGENT_COLORS[t]}` }}
                      />
                      <span className="font-mono text-[11px] font-semibold text-zinc-200">{f.agentId}</span>
                      <Badge
                        variant="outline"
                        className="ml-auto font-mono text-[9px] uppercase tracking-widest"
                        style={{ borderColor: ACTION_COLORS[f.action] + "60", color: ACTION_COLORS[f.action] }}
                      >
                        {f.action}
                      </Badge>
                      <span className="font-mono text-[10px] text-zinc-500 tabular-nums">t{f.tick}</span>
                    </div>
                    {f.amount != null && (
                      <div className="mt-1 pl-4 font-mono text-[10px] text-zinc-400 tabular-nums">
                        amount {f.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </div>
                    )}
                    {f.reasoning && (
                      <p className="mt-1 pl-4 text-[10px] italic text-zinc-500 line-clamp-2">&ldquo;{f.reasoning}&rdquo;</p>
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
