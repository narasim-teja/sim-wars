"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import type { AgentRuntime } from "@/lib/types";
import { AGENT_COLORS, AGENT_LABELS, edgeColor } from "@/lib/agent-colors";
import type { SimUiState } from "@/hooks/useSimulation";
import { GraphHeader, LivePill } from "./GraphHeader";

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
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const nodesRef = useRef<Map<string, NodeDatum>>(new Map());
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [showEdgeLabels, setShowEdgeLabels] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // ─── container size ──────────────────────────────────────────────────
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

  // ─── fullscreen tracking ─────────────────────────────────────────────
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // ─── force simulation ────────────────────────────────────────────────
  useEffect(() => {
    const sim = d3
      .forceSimulation<NodeDatum>([])
      .force("charge", d3.forceManyBody().strength(-280))
      .force("center", d3.forceCenter(size.w / 2, size.h / 2))
      .force("collide", d3.forceCollide<NodeDatum>().radius((d) => radiusFor(d.balance) + 8))
      .force(
        "link",
        d3.forceLink<NodeDatum, LinkDatum>([]).id((d) => d.id).distance(150).strength(0.05),
      )
      .alphaDecay(0.03);

    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, [size.w, size.h]);

  // ─── nodes & links ──────────────────────────────────────────────────
  // Splitting "build incoming list" (pure, memoized) from "merge with prior
  // positions in nodesRef" (effect-local). React 19's `react-hooks/refs`
  // rule forbids reading or writing refs during render — and d3-force
  // *needs* node-object identity to be preserved across renders to keep
  // x/y/vx/vy. So: pure list memoized; merge happens inside the effect that
  // publishes to the simulation, and the merged list is mirrored to state
  // for the d3-selection render effect to consume.
  const { incoming, links, maxBalance } = useMemo(() => {
    const agents = Object.values(state.agents);
    const balances = agents.map((a) => a.balance);
    const maxB = balances.length ? Math.max(...balances) : 1;

    const incoming: NodeDatum[] = agents.map((a: AgentRuntime) => ({
      id: a.id,
      type: a.type as keyof typeof AGENT_COLORS,
      balance: a.balance,
      lastActionTick: a.lastAction?.tick,
    }));

    const links: LinkDatum[] = state.edges.map((e) => ({
      id: e.id,
      tick: e.tick,
      action: e.action,
      amount: e.amount,
      age: state.tick - e.tick,
      source: e.from,
      target: e.to,
    }));

    return { incoming, links, maxBalance: maxB };
  }, [state.agents, state.edges, state.tick]);

  // `nodes` is the merged list: incoming stats + persisted positions from
  // the ref. Stored in state so the d3-selection effect re-runs when it
  // changes; the ref keeps the d3-force-mutated copy authoritative for
  // imperative ops (handleRefresh).
  const [nodes, setNodes] = useState<NodeDatum[]>([]);

  useEffect(() => {
    if (!simRef.current) return;
    const merged = incoming.map((n) => {
      const prev = nodesRef.current.get(n.id);
      // Preserve x/y/vx/vy/fx/fy from the prior frame; overwrite presentational fields.
      return prev ? Object.assign(prev, n) : n;
    });
    nodesRef.current = new Map(merged.map((n) => [n.id, n]));
    setNodes(merged);
    const sim = simRef.current;
    sim.nodes(merged);
    (sim.force("link") as d3.ForceLink<NodeDatum, LinkDatum>).links(links);
    sim.alpha(0.5).restart();
  }, [incoming, links]);

  // ─── render ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!svgRef.current || !simRef.current) return;
    const svg = d3.select(svgRef.current);
    const sim = simRef.current;

    // Lazy init: defs + zoomable root group
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

    let root = svg.select<SVGGElement>("g.zoom-root");
    if (root.empty()) {
      root = svg.append("g").attr("class", "zoom-root");
      root.append("g").attr("class", "edges");
      root.append("g").attr("class", "edge-labels");
      root.append("g").attr("class", "nodes");
      root.append("g").attr("class", "node-labels");

      // d3.zoom — pan/zoom the root group
      const zoom = d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.25, 5])
        .filter((event) => {
          // ignore zoom on right-click + on pinch from a node drag
          return !event.button && !event.ctrlKey;
        })
        .on("zoom", (event) => {
          root.attr("transform", event.transform.toString());
        });
      svg.call(zoom);
      zoomRef.current = zoom;
    }

    const edgesG = root.select<SVGGElement>("g.edges");
    const edgeLabelsG = root.select<SVGGElement>("g.edge-labels");
    const nodesG = root.select<SVGGElement>("g.nodes");
    const nodeLabelsG = root.select<SVGGElement>("g.node-labels");

    // ─── Edges
    const linkSel = edgesG
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

    // ─── Edge labels (action name in middle)
    const edgeLabelSel = edgeLabelsG
      .selectAll<SVGTextElement, LinkDatum>("text.edge-label")
      .data(showEdgeLabels ? links : [], (d) => d.id);
    edgeLabelSel.exit().remove();
    const edgeLabelEnter = edgeLabelSel
      .enter()
      .append("text")
      .attr("class", "edge-label")
      .attr("text-anchor", "middle")
      .attr("dy", "0.32em")
      .style("font-family", "ui-monospace, monospace")
      .style("font-size", "9px")
      .style("font-weight", "600")
      .style("pointer-events", "none")
      .style("paint-order", "stroke")
      .style("stroke", "#ffffff")
      .style("stroke-width", "3px");
    const allEdgeLabels = edgeLabelEnter.merge(edgeLabelSel);
    allEdgeLabels
      .style("fill", (d) => edgeColor(d.action as never))
      .text((d) => d.action.toUpperCase().replace(/_/g, " "));

    // ─── Nodes
    const nodeSel = nodesG
      .selectAll<SVGGElement, NodeDatum>("g.node")
      .data(nodes, (d) => d.id);
    nodeSel.exit().remove();

    const nodeEnter = nodeSel
      .enter()
      .append("g")
      .attr("class", "node")
      .style("cursor", "pointer")
      .on("click", (event, d) => {
        event.stopPropagation();
        onSelect(d.id);
      });

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

    // ─── Drag — reposition nodes by dragging
    const drag = d3
      .drag<SVGGElement, NodeDatum>()
      .on("start", (event, d) => {
        if (!event.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) sim.alphaTarget(0);
        // Release the pin so the layout can keep settling
        d.fx = null;
        d.fy = null;
      });
    allNodes.call(drag as never);

    // ─── Node labels (small id under the circle)
    const nodeLabelSel = nodeLabelsG
      .selectAll<SVGTextElement, NodeDatum>("text.node-label")
      .data(nodes, (d) => d.id);
    nodeLabelSel.exit().remove();
    const nodeLabelEnter = nodeLabelSel
      .enter()
      .append("text")
      .attr("class", "node-label")
      .attr("text-anchor", "middle")
      .style("font-family", "ui-monospace, monospace")
      .style("font-size", "10px")
      .style("font-weight", "500")
      .style("pointer-events", "none")
      .style("paint-order", "stroke")
      .style("stroke", "#ffffff")
      .style("stroke-width", "3px")
      .style("fill", "#3f3f46");
    const allNodeLabels = nodeLabelEnter.merge(nodeLabelSel);
    allNodeLabels.text((d) => d.id);

    // ─── Tick handler
    sim.on("tick", () => {
      allLinks
        .attr("x1", (d) => (d.source as NodeDatum).x ?? 0)
        .attr("y1", (d) => (d.source as NodeDatum).y ?? 0)
        .attr("x2", (d) => (d.target as NodeDatum).x ?? 0)
        .attr("y2", (d) => (d.target as NodeDatum).y ?? 0);

      allEdgeLabels
        .attr("x", (d) => {
          const s = (d.source as NodeDatum).x ?? 0;
          const t = (d.target as NodeDatum).x ?? 0;
          return (s + t) / 2;
        })
        .attr("y", (d) => {
          const s = (d.source as NodeDatum).y ?? 0;
          const t = (d.target as NodeDatum).y ?? 0;
          return (s + t) / 2;
        });

      allNodes.attr("transform", (d) => `translate(${d.x ?? 0}, ${d.y ?? 0})`);
      allNodeLabels
        .attr("x", (d) => d.x ?? 0)
        .attr("y", (d) => (d.y ?? 0) + radiusFor(d.balance, maxBalance) + 12);
    });

    // ─── Click background to deselect
    svg.on("click.bg", (event) => {
      if (event.target === svgRef.current) onSelect(null);
    });
  }, [nodes, links, maxBalance, selectedAgentId, onSelect, state.tick, showEdgeLabels]);

  // ─── Header callbacks ────────────────────────────────────────────────
  const handleRefresh = useCallback(() => {
    if (svgRef.current && zoomRef.current) {
      d3.select(svgRef.current)
        .transition()
        .duration(400)
        .call(zoomRef.current.transform, d3.zoomIdentity);
    }
    if (simRef.current) {
      // Release any pinned positions and rekick. d3-force's contract is
      // "I mutate the node objects you give me" — `fx`/`fy` are how callers
      // pin or unpin a node, and the simulation writes `x`/`y`/`vx`/`vy`
      // every tick. React 19's react-hooks/immutability rule can't model
      // this paradigm, so we disable it here. Mutating via the ref's copy
      // (not the React-state `nodes` array) keeps render-side immutability
      // invariants intact.
      for (const [, n] of nodesRef.current) {
        /* eslint-disable react-hooks/immutability */
        n.fx = null;
        n.fy = null;
        /* eslint-enable react-hooks/immutability */
      }
      simRef.current.alpha(0.9).restart();
    }
  }, []);

  const handleFullscreen = useCallback(async () => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await containerRef.current.requestFullscreen();
    }
  }, []);

  // ─── Render ──────────────────────────────────────────────────────────
  const usedTypes = useMemo(
    () => Array.from(new Set(nodes.map((n) => n.type))).filter((t) => t !== "unknown"),
    [nodes],
  );

  return (
    <div ref={containerRef} className="dot-bg relative h-full w-full bg-white">
      <div className="absolute left-4 top-3 z-10 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
        Graph Relationship Visualization
      </div>

      <GraphHeader
        onRefresh={handleRefresh}
        onFullscreen={handleFullscreen}
        isFullscreen={isFullscreen}
        showEdgeLabels={showEdgeLabels}
        onToggleEdgeLabels={() => setShowEdgeLabels((v) => !v)}
      />

      <svg ref={svgRef} className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing" viewBox={`0 0 ${size.w} ${size.h}`} />

      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="font-mono text-[12px] uppercase tracking-[0.3em] text-zinc-400">
            waiting for first tick…
          </div>
        </div>
      )}

      <LivePill status={state.status} />

      {/* Legend */}
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex max-w-md flex-col gap-1.5 rounded-md border border-zinc-200 bg-white/95 p-3 backdrop-blur">
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

      {/* Help text — bottom right */}
      <div className="pointer-events-none absolute bottom-3 right-3 z-10 rounded-md border border-zinc-200 bg-white/90 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500 backdrop-blur">
        scroll = zoom · drag = pan · click node
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
