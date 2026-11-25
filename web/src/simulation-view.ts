// Pure UI state for the simulation grid: one RunView per runId, fed by a single SSE stream. No React, no DOM.
import type { TraceEvent } from "../../api/types.ts";
import { initialView, reduce } from "./run-view.ts";
import type { RunView } from "./run-view.ts";

export type SimRunState = { view: RunView; lastTs: number };
export type SimState = { order: string[]; runs: Record<string, SimRunState>; finished: boolean };
export type SimMessage = { runId: string; event: TraceEvent };
export type SimSummary = { total: number; running: number; done: number; error: number; medianStartupMs: number | undefined };

export function initialSim(): SimState {
  return { order: [], runs: {}, finished: false };
}

// Only the run the event belongs to gets a new object; every other tile keeps its identity, so React can skip it.
export function reduceSimulation(state: SimState, { runId, event }: SimMessage): SimState {
  const prev = state.runs[runId];
  const next: SimRunState = { view: reduce(prev?.view ?? initialView(), event), lastTs: event.ts };
  return { ...state, order: prev ? state.order : [...state.order, runId], runs: { ...state.runs, [runId]: next } };
}

export function finishSimulation(state: SimState): SimState {
  return { ...state, finished: true };
}

export function summarizeSimulation(state: SimState): SimSummary {
  const s: SimSummary = { total: 0, running: 0, done: 0, error: 0, medianStartupMs: undefined };
  const startups: number[] = [];
  for (const { view } of Object.values(state.runs)) {
    s.total++;
    if (view.phase === "done") s.done++;
    else if (view.phase === "error") s.error++;
    else s.running++;
    if (view.startupMs !== undefined) startups.push(view.startupMs);
  }
  if (startups.length > 0) {
    startups.sort((a, b) => a - b);
    const mid = startups.length >> 1;
    s.medianStartupMs = startups.length % 2 ? startups[mid] : (startups[mid - 1] + startups[mid]) / 2;
  }
  return s;
}

// Milliseconds from sandbox_resuming to the run's latest event, or undefined before it started.
export function tileElapsedMs(run: SimRunState): number | undefined {
  return run.view.startedAt === undefined ? undefined : run.lastTs - run.view.startedAt;
}

// Collects items and hands them over once per animation frame, so 100 runs do not cause 900 renders.
export function createBatcher<T>(o: { requestFrame: (cb: () => void) => void; onFlush: (items: T[]) => void }): { push(item: T): void } {
  let items: T[] = [];
  const flush = () => { const batch = items; items = []; o.onFlush(batch); };
  return { push(item) { if (items.push(item) === 1) o.requestFrame(flush); } };
}
