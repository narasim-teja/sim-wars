"use client";

/**
 * Stylised force-graph silhouette — the hero illustration on the setup page.
 * Hand-laid out so it reads as "many agents connecting", echoing the live sim.
 */
export function HeroIllustration({ className }: { className?: string }) {
  // Hand-tuned positions; treat as decorative.
  const nodes: { x: number; y: number; r: number; c: string }[] = [
    { x: 230, y: 170, r: 28, c: "#0a0a0a" }, // central whale
    { x: 110, y: 110, r: 12, c: "#f97316" },
    { x: 90,  y: 220, r: 14, c: "#3b82f6" },
    { x: 360, y: 110, r: 14, c: "#10b981" },
    { x: 380, y: 220, r: 12, c: "#a855f7" },
    { x: 200, y: 60,  r: 10, c: "#ec4899" },
    { x: 270, y: 320, r: 16, c: "#06b6d4" },
    { x: 130, y: 340, r: 11, c: "#facc15" },
    { x: 60,  y: 290, r: 9,  c: "#71717a" },
    { x: 340, y: 320, r: 10, c: "#84cc16" },
    { x: 420, y: 170, r: 10, c: "#f43f5e" },
    { x: 30,  y: 170, r: 8,  c: "#22c55e" },
    { x: 175, y: 270, r: 9,  c: "#0a0a0a" },
    { x: 295, y: 235, r: 8,  c: "#3b82f6" },
  ];
  const edges: [number, number, string][] = [
    [0, 1, "#0a0a0a"],
    [0, 2, "#0a0a0a"],
    [0, 3, "#0a0a0a"],
    [0, 4, "#0a0a0a"],
    [0, 6, "#ef4444"],
    [0, 12, "#0a0a0a"],
    [0, 13, "#0a0a0a"],
    [1, 5, "#0a0a0a"],
    [2, 8, "#0a0a0a"],
    [3, 5, "#0a0a0a"],
    [3, 10, "#0a0a0a"],
    [4, 9, "#0a0a0a"],
    [4, 6, "#ef4444"],
    [6, 7, "#ef4444"],
    [6, 9, "#0a0a0a"],
    [6, 13, "#0a0a0a"],
    [7, 8, "#0a0a0a"],
    [10, 3, "#0a0a0a"],
    [11, 2, "#0a0a0a"],
    [12, 7, "#0a0a0a"],
    [13, 3, "#0a0a0a"],
  ];

  return (
    <svg
      viewBox="0 0 480 400"
      className={className}
      role="img"
      aria-label="Force graph of adversarial agents"
    >
      <defs>
        <radialGradient id="hero-glow" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#fafafa" stopOpacity="1" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width="480" height="400" fill="url(#hero-glow)" />

      {/* Concentric arc — gives the "world" feeling */}
      <circle cx="230" cy="200" r="180" fill="none" stroke="#e4e4e7" strokeDasharray="2 6" />
      <circle cx="230" cy="200" r="120" fill="none" stroke="#e4e4e7" strokeDasharray="2 6" />

      {/* Edges */}
      {edges.map(([a, b, color], i) => {
        const A = nodes[a];
        const B = nodes[b];
        return (
          <line
            key={i}
            x1={A.x}
            y1={A.y}
            x2={B.x}
            y2={B.y}
            stroke={color}
            strokeOpacity={color === "#ef4444" ? 0.7 : 0.35}
            strokeWidth={color === "#ef4444" ? 1.4 : 1}
          />
        );
      })}

      {/* Nodes */}
      {nodes.map((n, i) => (
        <g key={i}>
          <circle cx={n.x} cy={n.y} r={n.r + 4} fill={n.c} opacity={0.12} />
          <circle cx={n.x} cy={n.y} r={n.r} fill={n.c} stroke="#ffffff" strokeWidth={2} />
        </g>
      ))}
    </svg>
  );
}
