"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import type { AgentRuntime } from "@/lib/types";
import { AGENT_COLORS, AGENT_LABELS, edgeColor } from "@/lib/agent-colors";
import type { SimUiState } from "@/hooks/useSimulation";

interface NodeDatum extends d3.SimulationNodeDatum {
  id: string;
  type: keyof typeof AGENT_COLORS;
  balance: number;
  lastActionTick?: number;
}

interface LinkDatum extends d3.SimulationLinkDatum<NodeDatum> {
  id: string;
  tick: number;
  action: string;
  amount: number | null;
  age: number;
}

const NODE_RADIUS_MIN = 8;
const NODE_RADIUS_MAX = 28;

export function AgentGraph({
  state,
  onSelect,
  selectedAgentId,
}: {
  state: SimUiState;
  onSelect: (agentId: string | null) => void;
  selectedAgentId: string | null;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const simRef = useRef<d3.Simulation<NodeDatum, LinkDatum> | null>(null);
  const nodesRef = useRef<Map<string, NodeDatum>>(new Map());
  const [size, setSize] = useState({ w: 800, h: 600 });

  // Track container size
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        setSize({ w: Math.max(300, width), h: Math.max(300, height) });
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Create / reuse simulation
  useEffect(() => {
    const sim = d3
      .forceSimulation<NodeDatum>([])
      .force("charge", d3.forceManyBody().strength(-220))
      .force("center", d3.forceCenter(size.w / 2, size.h / 2))
      .force("collide", d3.forceCollide<NodeDatum>().radius((d) => radiusFor(d.balance) + 4))
      .force(
        "link",
        d3.forceLink<NodeDatum, LinkDatum>([]).id((d) => d.id).distance(120).strength(0.05),
      )
      .alphaDecay(0.03);

    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, [size.w, size.h]);

  // Build nodes & links from state
  const { nodes, links, maxBalance } = useMemo(() => {
    const agents = Object.values(state.agents);
    const balances = agents.map((a) => a.balance);
    const maxB = balances.length ? Math.max(...balances) : 1;

    const incoming: NodeDatum[] = agents.map((a: AgentRuntime) => ({
      id: a.id,
      type: a.type as keyof typeof AGENT_COLORS,
      balance: a.balance,
      lastActionTick: a.lastAction?.tick,
    }));

    // Reuse existing position so the graph doesn't jump on every tick
    const reused = incoming.map((n) => {
      const prev = nodesRef.current.get(n.id);
      return prev ? { ...prev, ...n } : n;
    });
    nodesRef.current = new Map(reused.map((n) => [n.id, n]));

    const links: LinkDatum[] = state.edges.map((e) => ({
      id: e.id,
      tick: e.tick,
      action: e.action,
      amount: e.amount,
      age: state.tick - e.tick,
      source: e.from,
      target: e.to,
    }));

    return { nodes: reused, links, maxBalance: maxB };
  }, [state.agents, state.edges, state.tick]);

  // Apply nodes/links to simulation
  useEffect(() => {
    if (!simRef.current) return;
    const sim = simRef.current;
    sim.nodes(nodes);
    (sim.force("link") as d3.ForceLink<NodeDatum, LinkDatum>).links(links);
    sim.alpha(0.5).restart();
  }, [nodes, links]);

  // Render loop — draw to SVG via D3 selection
  useEffect(() => {
    if (!svgRef.current || !simRef.current) return;
    const svg = d3.select(svgRef.current);
    const sim = simRef.current;

    // Defs (gradients + glow)
    let defs = svg.select<SVGDefsElement>("defs");
    if (defs.empty()) {
      defs = svg.append("defs");
      const filter = defs
        .append("filter")
        .attr("id", "node-glow")
        .attr("x", "-50%")
        .attr("y", "-50%")
        .attr("width", "200%")
        .attr("height", "200%");
      filter.append("feGaussianBlur").attr("stdDeviation", "3").attr("result", "blur");
      const merge = filter.append("feMerge");
      merge.append("feMergeNode").attr("in", "blur");
      merge.append("feMergeNode").attr("in", "SourceGraphic");
    }

    // Links (under nodes)
    const linkSel = svg
      .selectAll<SVGLineElement, LinkDatum>("line.edge")
      .data(links, (d) => d.id);
    linkSel.exit().remove();
    const linkEnter = linkSel
      .enter()
      .append("line")
      .attr("class", "edge")
      .attr("stroke-width", 1.4)
      .attr("opacity", 0)
      .attr("stroke-linecap", "round");
    linkEnter
      .transition()
      .duration(180)
      .attr("opacity", 0.85);
    const allLinks = linkEnter.merge(linkSel);
    allLinks
      .attr("stroke", (d) => edgeColor(d.action as never))
      .attr("opacity", (d) => {
        const fade = Math.max(0, 1 - d.age / 4);
        return 0.2 + 0.6 * fade;
      })
      .attr("stroke-dasharray", (d) =>
        d.action === "vote_yes" || d.action === "vote_no" || d.action === "propose" ? "4 3" : null,
      );

    // Nodes group
    const nodeSel = svg
      .selectAll<SVGGElement, NodeDatum>("g.node")
      .data(nodes, (d) => d.id);
    nodeSel.exit().remove();

    const nodeEnter = nodeSel
      .enter()
      .append("g")
      .attr("class", "node")
      .style("cursor", "pointer")
      .on("click", (_, d) => onSelect(d.id));
    nodeEnter
      .append("circle")
      .attr("class", "halo")
      .attr("r", 0)
      .attr("fill", "transparent")
      .attr("stroke-width", 1.2)
      .attr("opacity", 0);
    nodeEnter
      .append("circle")
      .attr("class", "core")
      .attr("filter", "url(#node-glow)")
      .attr("r", 0)
      .attr("opacity", 0)
      .transition()
      .duration(220)
      .attr("opacity", 1)
      .attr("r", (d) => radiusFor(d.balance, maxBalance));
    nodeEnter
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.32em")
      .style("font-family", "ui-monospace, monospace")
      .style("font-size", "9px")
      .style("font-weight", "600")
      .style("pointer-events", "none")
      .style("fill", "rgba(0,0,0,0.85)")
      .text((d) => initialsFor(d.id));

    const allNodes = nodeEnter.merge(nodeSel);
    allNodes
      .select<SVGCircleElement>("circle.core")
      .attr("fill", (d) => AGENT_COLORS[d.type] ?? "#71717a")
      .attr("stroke", (d) => (selectedAgentId === d.id ? "#22d3ee" : "rgba(0,0,0,0.4)"))
      .attr("stroke-width", (d) => (selectedAgentId === d.id ? 2.5 : 1))
      .transition()
      .duration(220)
      .attr("r", (d) => radiusFor(d.balance, maxBalance));

    // Halo pulse if last action is recent (within 1 tick)
    allNodes
      .select<SVGCircleElement>("circle.halo")
      .attr("stroke", (d) => AGENT_COLORS[d.type] ?? "#71717a")
      .each(function (d) {
        const recent = d.lastActionTick != null && state.tick - d.lastActionTick <= 1;
        const sel = d3.select(this);
        if (recent) {
          sel
            .attr("opacity", 0.7)
            .attr("r", radiusFor(d.balance, maxBalance) + 2)
            .transition()
            .duration(900)
            .attr("r", radiusFor(d.balance, maxBalance) + 22)
            .attr("opacity", 0);
        }
      });

    // Tick handler — update positions
    sim.on("tick", () => {
      allLinks
        .attr("x1", (d) => (d.source as NodeDatum).x ?? 0)
        .attr("y1", (d) => (d.source as NodeDatum).y ?? 0)
        .attr("x2", (d) => (d.target as NodeDatum).x ?? 0)
        .attr("y2", (d) => (d.target as NodeDatum).y ?? 0);
      allNodes.attr("transform", (d) => `translate(${d.x ?? 0}, ${d.y ?? 0})`);
    });
  }, [nodes, links, maxBalance, selectedAgentId, onSelect, state.tick]);

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <svg ref={svgRef} className="absolute inset-0 h-full w-full" viewBox={`0 0 ${size.w} ${size.h}`} />

      {/* Empty state */}
      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="font-mono text-xs uppercase tracking-[0.3em] text-zinc-600">
            waiting for first tick…
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-md flex-wrap gap-1.5 rounded border border-white/5 bg-black/60 p-2 backdrop-blur">
        {Object.entries(AGENT_LABELS)
          .filter(([k]) => k !== "unknown")
          .filter(([k]) => nodes.some((n) => n.type === k))
          .map(([k, label]) => (
            <div key={k} className="flex items-center gap-1.5 px-1">
              <span
                className="h-2 w-2 rounded-full"
                style={{
                  background: AGENT_COLORS[k as keyof typeof AGENT_COLORS],
                  boxShadow: `0 0 6px ${AGENT_COLORS[k as keyof typeof AGENT_COLORS]}`,
                }}
              />
              <span className="font-mono text-[9px] uppercase tracking-widest text-zinc-400">{label}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

function radiusFor(balance: number, max?: number): number {
  if (!max || max <= 0) return NODE_RADIUS_MIN;
  const ratio = Math.sqrt(Math.max(0, balance) / max);
  return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * ratio;
}

function initialsFor(id: string): string {
  const [head, num] = id.split("_");
  return `${head[0] ?? "?"}${num ?? ""}`.slice(0, 4);
}
