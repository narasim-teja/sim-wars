import { cn } from "@/lib/utils";

export type FieldSource = "extracted" | "default" | "edited";

const STYLES: Record<FieldSource, string> = {
  extracted: "border-emerald-200 bg-emerald-50 text-emerald-700",
  default: "border-zinc-200 bg-zinc-50 text-zinc-500",
  edited: "border-amber-200 bg-amber-50 text-amber-700",
};

const LABELS: Record<FieldSource, string> = {
  extracted: "extracted",
  default: "default",
  edited: "edited",
};

export function FieldBadge({ source, className }: { source: FieldSource; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 items-center rounded-sm border px-1.5 font-mono text-[9px] uppercase tracking-[0.18em]",
        STYLES[source],
        className,
      )}
    >
      {LABELS[source]}
    </span>
  );
}
