// UI state behind the simulation grid. Run: node --test tests/unit/simulation-view.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { initialSim, reduceSimulation, finishSimulation, summarizeSimulation, tileElapsedMs, createBatcher } from "../../web/src/simulation-view.ts";
import type { SimState } from "../../web/src/simulation-view.ts";
import { planSimulation, simulationEvents } from "../../api/simulation.ts";
import type { TraceEvent } from "../../api/types.ts";

const msg = (runId: string, event: TraceEvent) => ({ runId, event });
const play = (msgs: { runId: string; event: TraceEvent }[], from: SimState = initialSim()) => msgs.reduce(reduceSimulation, from);
const tile = (s: SimState, id: string) => {
  assert.ok(s.runs[id], `no tile for ${id}`);
  return s.runs[id];
};
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === "object") { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
};

describe("initialSim", () => {
  test("starts empty and not finished", () => {
    assert.deepEqual(initialSim(), { order: [], runs: {}, finished: false });
  });
});

describe("reduceSimulation", () => {
  test("the first event of a new runId adds a tile, in first-seen order, with the normal run view", () => {
    const s = play([msg("b", { type: "sandbox_resuming", ts: 10 }), msg("a", { type: "sandbox_resuming", ts: 20 })]);
    assert.deepEqual(s.order, ["b", "a"]);
    assert.equal(tile(s, "b").view.phase, "resuming");
    assert.equal(tile(s, "a").view.phase, "resuming");
  });

  test("events are routed to their own run, and the other runs are left untouched (same object)", () => {
    const s1 = play([msg("a", { type: "sandbox_resuming", ts: 0 }), msg("b", { type: "sandbox_resuming", ts: 0 })]);
    const s2 = reduceSimulation(s1, msg("a", { type: "sandbox_ready", ts: 1500, startupMs: 1500 }));
    assert.equal(tile(s2, "a").view.phase, "ready");
    assert.equal(tile(s2, "a").view.startupMs, 1500);
    assert.equal(tile(s2, "b"), tile(s1, "b"));
    assert.equal(tile(s2, "b").view.phase, "resuming");
  });

  test("a run's reasoning and terminal output stay in that run only", () => {
    const s = play([
      msg("a", { type: "sandbox_resuming", ts: 0 }),
      msg("b", { type: "sandbox_resuming", ts: 0 }),
      msg("a", { type: "reasoning", ts: 5, text: "only for a" }),
      msg("b", { type: "stdout", ts: 6, text: "only for b" }),
    ]);
    assert.deepEqual(tile(s, "a").view.reasoning.map((r) => r.text), ["only for a"]);
    assert.equal(tile(s, "a").view.terminal.length, 0);
    assert.deepEqual(tile(s, "b").view.terminal.map((t) => t.text), ["only for b"]);
    assert.equal(tile(s, "b").view.reasoning.length, 0);
  });

  test("done with exit 0 marks the run done, a non-zero exit marks it error", () => {
    const s = play([
      msg("a", { type: "sandbox_resuming", ts: 0 }), msg("a", { type: "done", ts: 9, exitCode: 0 }),
      msg("b", { type: "sandbox_resuming", ts: 0 }), msg("b", { type: "done", ts: 9, exitCode: 1 }),
    ]);
    assert.equal(tile(s, "a").view.phase, "done");
    assert.equal(tile(s, "b").view.phase, "error");
  });

  test("lastTs follows the newest event, and tileElapsedMs is the time since sandbox_resuming", () => {
    const s = play([msg("a", { type: "sandbox_resuming", ts: 100 }), msg("a", { type: "sandbox_ready", ts: 1700, startupMs: 1600 })]);
    assert.equal(tile(s, "a").lastTs, 1700);
    assert.equal(tileElapsedMs(tile(s, "a")), 1600);
  });

  test("tileElapsedMs is undefined for a run that has not started", () => {
    assert.equal(tileElapsedMs(tile(play([msg("a", { type: "sandbox_resuming", ts: 100 })]), "a")), 0, "started run: 0 ms after resuming");
    assert.equal(tileElapsedMs({ view: { phase: "idle", reasoning: [], terminal: [] }, lastTs: 0 }), undefined);
  });

  test("never mutates the previous state or the message", () => {
    const s1 = deepFreeze(play([msg("a", { type: "sandbox_resuming", ts: 0 })]));
    const m = deepFreeze(msg("a", { type: "stdout", ts: 5, text: "x" }));
    const s2 = reduceSimulation(s1, m);
    assert.notEqual(s2, s1);
    assert.equal(tile(s1, "a").view.terminal.length, 0);
    assert.equal(tile(s2, "a").view.terminal.length, 1);
    assert.deepEqual(s1.order, ["a"]);
  });

  test("replaying a whole 100-run simulation ends with 100 tiles, each finished with the planned outcome", () => {
    const plan = planSimulation({ n: 100, seed: 42 });
    const s = play(simulationEvents(plan).map((e) => msg(e.runId, e.event)));
    assert.equal(s.order.length, 100);
    for (const r of plan) assert.equal(tile(s, r.runId).view.phase, r.outcome, r.runId);
  });
});

describe("finishSimulation", () => {
  test("marks the simulation finished without mutating the old state", () => {
    const s1 = deepFreeze(play([msg("a", { type: "sandbox_resuming", ts: 0 })]));
    const s2 = finishSimulation(s1);
    assert.equal(s2.finished, true);
    assert.equal(s1.finished, false);
    assert.deepEqual(s2.order, ["a"]);
  });
});

describe("summarizeSimulation", () => {
  test("an empty simulation has zero counts and no median", () => {
    assert.equal(summarizeSimulation(play([msg("a", { type: "sandbox_resuming", ts: 0 })])).total, 1);
    assert.deepEqual(summarizeSimulation(initialSim()), { total: 0, running: 0, done: 0, error: 0, medianStartupMs: undefined });
  });

  test("counts running (resuming, ready or working), done and error separately", () => {
    const s = play([
      msg("r1", { type: "sandbox_resuming", ts: 0 }),
      msg("r2", { type: "sandbox_resuming", ts: 0 }), msg("r2", { type: "sandbox_ready", ts: 1, startupMs: 1 }),
      msg("r3", { type: "sandbox_resuming", ts: 0 }), msg("r3", { type: "sandbox_ready", ts: 1, startupMs: 1 }), msg("r3", { type: "stdout", ts: 2, text: "x" }),
      msg("d", { type: "sandbox_resuming", ts: 0 }), msg("d", { type: "done", ts: 3, exitCode: 0 }),
      msg("e", { type: "sandbox_resuming", ts: 0 }), msg("e", { type: "done", ts: 3, exitCode: 1 }),
    ]);
    assert.deepEqual(summarizeSimulation(s), { total: 5, running: 3, done: 1, error: 1, medianStartupMs: 1 });
  });

  test("the median startup uses the middle value, or the mean of the two middle values", () => {
    const withStartups = (xs: number[]) =>
      play(xs.flatMap((x, i) => [msg(`r${i}`, { type: "sandbox_resuming" as const, ts: 0 }), msg(`r${i}`, { type: "sandbox_ready" as const, ts: x, startupMs: x })]));
    assert.equal(summarizeSimulation(withStartups([2400, 1300, 1900])).medianStartupMs, 1900);
    assert.equal(summarizeSimulation(withStartups([1300, 2400, 1500, 1700])).medianStartupMs, 1600);
  });

  test("runs that have not reported a startup yet are left out of the median", () => {
    const s = play([
      msg("a", { type: "sandbox_resuming", ts: 0 }), msg("a", { type: "sandbox_ready", ts: 2000, startupMs: 2000 }),
      msg("b", { type: "sandbox_resuming", ts: 0 }),
    ]);
    assert.equal(summarizeSimulation(s).medianStartupMs, 2000);
    assert.equal(summarizeSimulation(s).total, 2);
  });

  test("a full replay of 100 runs summarises to the planned done and error counts, with nothing left running", () => {
    const plan = planSimulation({ n: 100, seed: 42 });
    const s = play(simulationEvents(plan).map((e) => msg(e.runId, e.event)));
    const errors = plan.filter((r) => r.outcome === "error").length;
    assert.deepEqual(summarizeSimulation(s), { ...summarizeSimulation(s), total: 100, running: 0, done: 100 - errors, error: errors });
    assert.ok(summarizeSimulation(s).medianStartupMs! >= 1300 && summarizeSimulation(s).medianStartupMs! <= 2400);
  });
});

describe("createBatcher", () => {
  function setup() {
    const frames: (() => void)[] = [];
    const flushed: number[][] = [];
    const b = createBatcher<number>({ requestFrame: (cb) => frames.push(cb), onFlush: (items) => flushed.push(items) });
    return { b, frames, flushed };
  }

  test("many pushes in one frame request one frame and flush once, in order", () => {
    const { b, frames, flushed } = setup();
    for (const n of [1, 2, 3]) b.push(n);
    assert.equal(frames.length, 1);
    assert.deepEqual(flushed, []);
    assert.ok(frames[0], "frame 0 must have been requested");
    frames[0]();
    assert.deepEqual(flushed, [[1, 2, 3]]);
  });

  test("a push after a flush requests a new frame and starts a new batch", () => {
    const { b, frames, flushed } = setup();
    b.push(1);
    assert.ok(frames[0], "frame 0 must have been requested");
    frames[0]();
    b.push(2);
    assert.equal(frames.length, 2);
    assert.ok(frames[1], "frame 1 must have been requested");
    frames[1]();
    assert.deepEqual(flushed, [[1], [2]]);
  });

  test("a frame is requested only once something is pushed, and nothing is flushed before the frame runs", () => {
    const { b, frames, flushed } = setup();
    assert.equal(frames.length, 0);
    b.push(0);
    assert.equal(frames.length, 1);
    assert.deepEqual(flushed, []);
  });

  test("a flushed batch is not changed by later pushes", () => {
    const { b, frames, flushed } = setup();
    b.push(1);
    assert.ok(frames[0], "frame 0 must have been requested");
    frames[0]();
    b.push(2);
    assert.deepEqual(flushed[0], [1]);
  });
});
