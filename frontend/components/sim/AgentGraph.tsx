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

const NODE_RADIUS_MIN = 9;
const NODE_RADIUS_MAX = 30;

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
      .force("charge", d3.forceManyBody().strength(-260))
      .force("center", d3.forceCenter(size.w / 2, size.h / 2))
      .force("collide", d3.forceCollide<NodeDatum>().radius((d) => radiusFor(d.balance) + 6))
      .force(
        "link",
        d3.forceLink<NodeDatum, LinkDatum>([]).id((d) => d.id).distance(140).strength(0.05),
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

  useEffect(() => {
    if (!simRef.current) return;
    const sim = simRef.current;
    sim.nodes(nodes);
    (sim.force("link") as d3.ForceLink<NodeDatum, LinkDatum>).links(links);
    sim.alpha(0.5).restart();
  }, [nodes, links]);

  useEffect(() => {
    if (!svgRef.current || !simRef.current) return;
    const svg = d3.select(svgRef.current);
    const sim = simRef.current;

    let defs = svg.select<SVGDefsElement>("defs");
    if (defs.empty()) {
      defs = svg.append("defs");
      const filter = defs
        .append("filter")
        .attr("id", "node-soft-shadow")
        .attr("x", "-50%")
        .attr("y", "-50%")
        .attr("width", "200%")
        .attr("height", "200%");
      filter
        .append("feDropShadow")
        .attr("dx", 0)
        .attr("dy", 1)
        .attr("stdDeviation", 1.4)
        .attr("flood-color", "rgba(0,0,0,0.18)");
    }

    // Edges
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
    linkEnter.transition().duration(180).attr("opacity", 0.85);
    const allLinks = linkEnter.merge(linkSel);
    allLinks
      .attr("stroke", (d) => edgeColor(d.action as never))
      .attr("opacity", (d) => {
        const fade = Math.max(0, 1 - d.age / 4);
        return 0.25 + 0.55 * fade;
      })
      .attr("stroke-dasharray", (d) =>
        d.action === "vote_yes" || d.action === "vote_no" || d.action === "propose" ? "4 3" : null,
      );

    // Nodes
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
      .attr("stroke-width", 1.5)
      .attr("opacity", 0);

    nodeEnter
      .append("circle")
      .attr("class", "core")
      .attr("filter", "url(#node-soft-shadow)")
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
      .style("fill", "#ffffff")
      .text((d) => initialsFor(d.id));

    const allNodes = nodeEnter.merge(nodeSel);
    allNodes
      .select<SVGCircleElement>("circle.core")
      .attr("fill", (d) => AGENT_COLORS[d.type] ?? "#71717a")
      .attr("stroke", (d) => (selectedAgentId === d.id ? "#0a0a0a" : "#ffffff"))
      .attr("stroke-width", (d) => (selectedAgentId === d.id ? 3 : 2))
      .transition()
      .duration(220)
      .attr("r", (d) => radiusFor(d.balance, maxBalance));

    // Halo pulse on recent action
    allNodes
      .select<SVGCircleElement>("circle.halo")
      .attr("stroke", (d) => AGENT_COLORS[d.type] ?? "#71717a")
      .each(function (d) {
        const recent = d.lastActionTick != null && state.tick - d.lastActionTick <= 1;
        const sel = d3.select(this);
        if (recent) {
          sel
            .attr("opacity", 0.55)
            .attr("r", radiusFor(d.balance, maxBalance) + 2)
            .transition()
            .duration(900)
            .attr("r", radiusFor(d.balance, maxBalance) + 26)
            .attr("opacity", 0);
        }
      });

    sim.on("tick", () => {
      allLinks
        .attr("x1", (d) => (d.source as NodeDatum).x ?? 0)
        .attr("y1", (d) => (d.source as NodeDatum).y ?? 0)
        .attr("x2", (d) => (d.target as NodeDatum).x ?? 0)
        .attr("y2", (d) => (d.target as NodeDatum).y ?? 0);
      allNodes.attr("transform", (d) => `translate(${d.x ?? 0}, ${d.y ?? 0})`);
    });
  }, [nodes, links, maxBalance, selectedAgentId, onSelect, state.tick]);

  const usedTypes = useMemo(
    () => Array.from(new Set(nodes.map((n) => n.type))).filter((t) => t !== "unknown"),
    [nodes],
  );

  return (
    <div ref={containerRef} className="dot-bg relative h-full w-full bg-white">
      <div className="absolute left-4 top-3 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
        Graph Relationship Visualization
      </div>

      <svg ref={svgRef} className="absolute inset-0 h-full w-full" viewBox={`0 0 ${size.w} ${size.h}`} />

      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="font-mono text-[12px] uppercase tracking-[0.3em] text-zinc-400">
            waiting for first tick…
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-md flex-col gap-1.5 rounded-md border border-zinc-200 bg-white/95 p-3 backdrop-blur">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">Entity types</div>
        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
          {usedTypes.map((k) => (
            <div key={k} className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: AGENT_COLORS[k as keyof typeof AGENT_COLORS] }}
              />
              <span className="font-mono text-[10px] text-zinc-700">
                {AGENT_LABELS[k as keyof typeof AGENT_LABELS]}
              </span>
            </div>
          ))}
        </div>
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
