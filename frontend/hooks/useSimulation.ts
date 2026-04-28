"use client";

import { useEffect, useReducer, useRef } from "react";
import type {
  WorkerEvent,
  SimulationState,
  AgentAction,
  AgentRuntime,
  FeedEntry,
  LogEntry,
  SimStatus,
  ActionType,
} from "@/lib/types";
import { agentTypeFromId } from "@/lib/agent-colors";

export interface SimSeriesPoint {
  tick: number;
  price: number;
  gini: number;
  staked: number;
  reserveBalance: number;
  pegPrice: number;
  apy: number;
}

export interface SimUiState {
  /** Connection lifecycle. WS may take a moment to open after the page loads. */
  connection: "connecting" | "open" | "closed";
  status: SimStatus | "starting";
  simId: string | null;
  tick: number;
  agentCount: number;
  maxTicks: number;
  /** Latest full SimulationState — every chart reads its current values from here. */
  current: SimulationState | null;
  /** Series for time-axis charts. Capped to last 200 ticks. */
  series: SimSeriesPoint[];
  /** Per-agent runtime view computed from topHolders + last action. */
  agents: Record<string, AgentRuntime>;
  /** Recent action edges for the graph (fade themselves over 3 ticks). */
  edges: { id: string; tick: number; from: string; to: string; action: ActionType; amount: number | null }[];
  /** Scrolling action feed. Capped to last 250 entries. */
  feed: FeedEntry[];
  /** Console log entries. Capped to last 250 entries. */
  logs: LogEntry[];
  deathSpiralAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
}

const SERIES_CAP = 200;
const FEED_CAP = 250;
const LOG_CAP = 250;
const EDGE_TTL_TICKS = 3;

function initialState(): SimUiState {
  return {
    connection: "connecting",
    status: "starting",
    simId: null,
    tick: 0,
    agentCount: 0,
    maxTicks: 0,
    current: null,
    series: [],
    agents: {},
    edges: [],
    feed: [],
    logs: [],
    deathSpiralAt: null,
    startedAt: null,
    endedAt: null,
  };
}

type Action =
  | { type: "ws"; status: "connecting" | "open" | "closed" }
  | { type: "event"; event: WorkerEvent };

function reducer(state: SimUiState, action: Action): SimUiState {
  if (action.type === "ws") return { ...state, connection: action.status };

  const ev = action.event;
  switch (ev.kind) {
    case "sim:start": {
      return {
        ...state,
        status: "running",
        simId: ev.simId,
        agentCount: ev.agentCount,
        maxTicks: ev.maxTicks,
        startedAt: ev.ts,
        logs: pushLog(state.logs, "system", `simulation started — ${ev.agentCount} agents, max ${ev.maxTicks} ticks`),
      };
    }

    case "tick:start": {
      return { ...state, tick: ev.tick };
    }

    case "tick:complete": {
      const { state: simState, actions, tick } = ev;
      const seriesPoint: SimSeriesPoint = {
        tick,
        price: simState.tokenPrice,
        gini: simState.giniCoefficient,
        staked: simState.totalSupply > 0 ? simState.stakedSupply / simState.totalSupply : 0,
        reserveBalance: simState.reserveBalance ?? 0,
        pegPrice: simState.pegPrice ?? 0,
        apy: simState.stakingAPY,
      };

      const series = [...state.series, seriesPoint].slice(-SERIES_CAP);

      // Build agents map from topHolders + last actions
      const agents = { ...state.agents };
      for (const h of simState.topHolders) {
        const t = agentTypeFromId(h.agentId);
        agents[h.agentId] = {
          id: h.agentId,
          type: t,
          name: h.agentId,
          balance: h.balance,
          lastAction: agents[h.agentId]?.lastAction,
        };
      }
      for (const a of actions) {
        const t = agentTypeFromId(a.agentId);
        const prev = agents[a.agentId];
        agents[a.agentId] = {
          id: a.agentId,
          type: t,
          name: a.agentId,
          balance: prev?.balance ?? 0,
          lastAction: a,
        };
      }

      // Edges: keep only recent (within EDGE_TTL_TICKS), then add new for non-hold actions
      const fresh = state.edges.filter((e) => tick - e.tick <= EDGE_TTL_TICKS);
      const newEdges = actions
        .filter((a) => a.action !== "hold" && a.success)
        .map((a) => ({
          id: `${tick}-${a.agentId}-${a.action}-${a.amount}`,
          tick,
          from: a.agentId,
          to: pickEdgeTarget(a, simState),
          action: a.action,
          amount: a.amount,
        }));
      const edges = [...fresh, ...newEdges];

      // Feed: append non-hold actions
      const feedAdditions: FeedEntry[] = actions
        .filter((a) => a.action !== "hold")
        .map((a) => ({
          id: `${tick}-${a.agentId}-${a.timestamp}`,
          ts: a.timestamp,
          tick,
          agentId: a.agentId,
          action: a.action,
          amount: a.amount,
          reasoning: a.reasoning,
          success: a.success,
          txSignature: a.txSignature,
        }));
      const feed = [...feedAdditions, ...state.feed].slice(0, FEED_CAP);

      const logs = pushLog(
        state.logs,
        "info",
        `tick ${tick} · ${actions.length} agents acted · price $${simState.tokenPrice.toFixed(4)} · gini ${simState.giniCoefficient.toFixed(3)}`,
      );

      return {
        ...state,
        tick,
        current: simState,
        series,
        agents,
        edges,
        feed,
        logs,
      };
    }

    case "sim:death_spiral": {
      return {
        ...state,
        status: "death_spiral",
        deathSpiralAt: ev.tick,
        logs: pushLog(state.logs, "error", `DEATH SPIRAL detected at tick ${ev.tick}`),
      };
    }

    case "sim:complete": {
      return {
        ...state,
        status: ev.status,
        endedAt: ev.ts,
        logs: pushLog(state.logs, "system", `simulation ${ev.status} after ${ev.totalTicks} ticks`),
      };
    }

    case "error": {
      return {
        ...state,
        logs: pushLog(state.logs, "error", `${ev.message}${ev.tick != null ? ` (tick ${ev.tick})` : ""}`),
      };
    }

    case "log": {
      return { ...state, logs: pushLog(state.logs, ev.level, ev.message) };
    }

    case "agent:action":
      return state; // tick:complete carries actions; per-action events would be redundant

    default:
      return state;
  }
}

function pushLog(logs: LogEntry[], level: LogEntry["level"], message: string): LogEntry[] {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return [{ id, ts: Date.now(), level, message }, ...logs].slice(0, LOG_CAP);
}

/** Edges need a target node — pick the largest counterparty so the graph reads. */
function pickEdgeTarget(action: AgentAction, sim: SimulationState): string {
  // Governance edges: target the proposal id as a synthetic node label, but
  // for the graph we just route to the top holder so the line points
  // toward the centre of mass.
  const top = sim.topHolders[0]?.agentId;
  if (top && top !== action.agentId) return top;
  const second = sim.topHolders[1]?.agentId;
  if (second) return second;
  return action.agentId; // self-loop fallback (rare)
}

export interface UseSimulationOptions {
  /** WS host — defaults to `NEXT_PUBLIC_SIM_API` or `http://localhost:8787`. */
  apiBase?: string;
}

export function useSimulation(simId: string, opts: UseSimulationOptions = {}) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!simId) return;
    const apiBase = opts.apiBase ?? process.env.NEXT_PUBLIC_SIM_API ?? "http://localhost:8787";
    const wsUrl = apiBase.replace(/^http/, "ws") + `/ws/sim/${simId}`;

    dispatch({ type: "ws", status: "connecting" });
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => dispatch({ type: "ws", status: "open" });
    ws.onclose = () => dispatch({ type: "ws", status: "closed" });
    ws.onerror = () => dispatch({ type: "ws", status: "closed" });
    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as WorkerEvent;
        dispatch({ type: "event", event });
      } catch {
        // ignore malformed
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [simId, opts.apiBase]);

  return state;
}
