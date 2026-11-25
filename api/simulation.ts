// Seeded synthetic runs for the 100-run UI demo. Pure: no clock, no I/O, no AWS. Never touches the RunStore.
import type { TraceEvent } from "./types.ts";

export type SimRun = {
  runId: string;
  startOffsetMs: number; // when this run starts, relative to the simulation start
  startupMs: number; // sandbox_resuming -> sandbox_ready
  runMs: number; // sandbox_ready -> done
  outcome: "done" | "error";
};
export type SimEvent = { at: number; runId: string; event: TraceEvent };

export const MAX_RUNS = 200;
export const STARTUP_RANGE_MS = [1300, 2400] as const; // measured cold start range (DECISION_LOG, Phase 4)
const RUN_RANGE_MS = [15_000, 50_000] as const;
const MAX_OFFSET_MS = 3000; // start jitter; keeps every run alive together (max ready 5.4 s < min done 16.3 s)
const ERROR_SHARE = 0.1;

// mulberry32: tiny seeded PRNG, so a seed always reproduces the same simulation.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function planSimulation({ n, seed }: { n: number; seed: number }): SimRun[] {
  if (!Number.isInteger(n) || n < 1 || n > MAX_RUNS) throw new RangeError(`n must be an integer from 1 to ${MAX_RUNS}`);
  const r = rng(seed);
  const between = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  return Array.from({ length: n }, (_, i) => ({
    runId: `sim-${seed}-${i}`,
    startOffsetMs: between(0, MAX_OFFSET_MS),
    startupMs: between(...STARTUP_RANGE_MS),
    runMs: between(...RUN_RANGE_MS),
    outcome: r() < ERROR_SHARE ? "error" : "done",
  }));
}

const DIFF =
  "diff --git a/app/Example.php b/app/Example.php\n--- a/app/Example.php\n+++ b/app/Example.php\n@@ -3,3 +3,4 @@ class Example\n {\n+    // Simulated change: no MicroVM produced this diff.\n     public function enabled(): bool\n     {\n";

export function simulationEvents(plan: SimRun[]): SimEvent[] {
  const out: SimEvent[] = [];
  for (const run of plan) {
    const ready = run.startOffsetMs + run.startupMs;
    const step = (frac: number, event: (ts: number) => TraceEvent) => {
      const at = ready + Math.round(run.runMs * frac);
      out.push({ at, runId: run.runId, event: event(at) });
    };
    const failed = run.outcome === "error";
    out.push({ at: run.startOffsetMs, runId: run.runId, event: { type: "sandbox_resuming", ts: run.startOffsetMs } });
    out.push({ at: ready, runId: run.runId, event: { type: "sandbox_ready", ts: ready, startupMs: run.startupMs } });
    step(0.1, (ts) => ({ type: "reasoning", ts, text: "Reading the repository to find the file to change." }));
    step(0.3, (ts) => ({ type: "reasoning", ts, text: "app/Example.php defines enabled(); adding a comment above it." }));
    step(0.5, (ts) => ({ type: "stdout", ts, text: "$ composer install --no-interaction\n" }));
    step(0.7, (ts) => ({ type: "stdout", ts, text: "$ php artisan test\n" }));
    step(0.8, (ts) => ({ type: "test_result", ts, exitCode: failed ? 1 : 0, summary: failed ? "tests failed (exit 1)" : "tests passed" }));
    step(0.9, (ts) => ({ type: "diff", ts, diff: DIFF }));
    if (failed) step(0.95, (ts) => ({ type: "stderr", ts, text: "simulated failure: 1 test failed" }));
    step(1, (ts) => ({ type: "done", ts, exitCode: failed ? 1 : 0 }));
  }
  return out.sort((a, b) => a.at - b.at); // Array.sort is stable, so same-time events keep their per-run order
}

// Window [from, to] in which every run is between sandbox_ready and done, or null when none exists.
export function allConcurrentWindow(events: SimEvent[]): { from: number; to: number } | null {
  let from = -Infinity;
  let to = Infinity;
  const seen = new Set<string>();
  for (const e of events) {
    if (e.event.type === "sandbox_ready") { from = Math.max(from, e.at); seen.add(e.runId); }
    if (e.event.type === "done") to = Math.min(to, e.at);
  }
  return seen.size > 0 && to > from ? { from, to } : null;
}
