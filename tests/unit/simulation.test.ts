// Seeded simulation generator. Run: node --test tests/unit/simulation.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planSimulation, simulationEvents, allConcurrentWindow, MAX_RUNS, STARTUP_RANGE_MS } from "../../api/simulation.ts";
import type { SimEvent } from "../../api/simulation.ts";

const SEQUENCE = ["sandbox_resuming", "sandbox_ready", "reasoning", "stdout", "test_result", "diff", "done"];
const typesOf = (evs: SimEvent[], runId: string) => evs.filter((e) => e.runId === runId).map((e) => e.event.type);

describe("planSimulation", () => {
  test("returns n runs with distinct ids", () => {
    const plan = planSimulation({ n: 100, seed: 1 });
    assert.equal(plan.length, 100);
    assert.equal(new Set(plan.map((r) => r.runId)).size, 100);
  });

  test("same seed gives the same plan; a different seed gives a different one", () => {
    const a = planSimulation({ n: 100, seed: 7 });
    assert.ok(a.length > 0);
    assert.deepEqual(a, planSimulation({ n: 100, seed: 7 }));
    assert.notDeepEqual(a, planSimulation({ n: 100, seed: 8 }));
  });

  test("n is bounds-checked: 1 to MAX_RUNS, integers only", () => {
    assert.equal(MAX_RUNS, 200);
    for (const n of [0, -1, 201, 1.5, NaN]) assert.throws(() => planSimulation({ n, seed: 1 }), RangeError, `n=${n}`);
    assert.equal(planSimulation({ n: 1, seed: 1 }).length, 1);
    assert.equal(planSimulation({ n: 200, seed: 1 }).length, 200);
  });

  test("startup times stay inside the measured range", () => {
    const plan = planSimulation({ n: 200, seed: 3 });
    assert.equal(plan.length, 200);
    for (const r of plan) {
      assert.ok(r.startupMs >= STARTUP_RANGE_MS[0] && r.startupMs <= STARTUP_RANGE_MS[1], `startupMs ${r.startupMs}`);
    }
  });

  test("run durations are 15 to 50 s and start offsets are spread over a few seconds", () => {
    const plan = planSimulation({ n: 200, seed: 3 });
    assert.equal(plan.length, 200);
    for (const r of plan) {
      assert.ok(r.runMs >= 15_000 && r.runMs <= 50_000, `runMs ${r.runMs}`);
      assert.ok(r.startOffsetMs >= 0 && r.startOffsetMs <= 3000, `offset ${r.startOffsetMs}`);
    }
    assert.ok(new Set(plan.map((r) => r.startOffsetMs)).size > 50, "offsets must be jittered, not all equal");
  });

  test("a small, seeded share of runs fail, and the share is reproducible", () => {
    const errs = (seed: number) => planSimulation({ n: 100, seed }).filter((r) => r.outcome === "error").length;
    for (const seed of [1, 2, 3, 4, 5]) {
      assert.ok(errs(seed) >= 1 && errs(seed) <= 25, `seed ${seed}: ${errs(seed)} errors out of 100`);
      assert.equal(errs(seed), errs(seed));
    }
  });
});

describe("simulationEvents", () => {
  const plan = planSimulation({ n: 100, seed: 42 });
  const evs = simulationEvents(plan);

  test("produces events for every planned run", () => {
    assert.equal(plan.length, 100);
    assert.equal(new Set(evs.map((e) => e.runId)).size, 100);
  });

  test("every run emits the standard sequence in order, ending in done", () => {
    assert.equal(plan.length, 100);
    for (const r of plan) {
      const t = typesOf(evs, r.runId).filter((x) => x !== "stderr");
      assert.deepEqual([...new Set(t)], SEQUENCE, r.runId);
      assert.equal(typesOf(evs, r.runId).at(-1), "done", r.runId);
    }
  });

  test("events are ordered in time overall and within each run", () => {
    assert.ok(evs.length > 0);
    for (let i = 1; i < evs.length; i++) assert.ok(evs[i].at >= evs[i - 1].at, `index ${i}`);
    for (const r of plan) {
      const mine = evs.filter((e) => e.runId === r.runId);
      assert.ok(mine.length >= SEQUENCE.length);
      for (let i = 1; i < mine.length; i++) assert.ok(mine[i].event.ts >= mine[i - 1].event.ts);
      assert.ok(mine.every((e) => e.event.ts === e.at), "event.ts is the simulation-relative time");
    }
  });

  test("sandbox_ready.startupMs equals the planned startup and the gap between resuming and ready", () => {
    assert.equal(plan.length, 100);
    for (const r of plan) {
      const mine = evs.filter((e) => e.runId === r.runId);
      const resuming = mine.find((e) => e.event.type === "sandbox_resuming");
      const ready = mine.find((e) => e.event.type === "sandbox_ready");
      assert.ok(resuming && ready, r.runId);
      assert.equal(resuming.at, r.startOffsetMs);
      assert.equal((ready.event as { startupMs: number }).startupMs, r.startupMs);
      assert.equal(ready.at - resuming.at, r.startupMs);
    }
  });

  test("outcome matches the run outcome rule: failed tests give a non-zero exit, stderr and done(error)", () => {
    assert.ok(plan.some((r) => r.outcome === "error") && plan.some((r) => r.outcome === "done"));
    for (const r of plan) {
      const mine = evs.filter((e) => e.runId === r.runId).map((e) => e.event);
      const test = mine.find((e) => e.type === "test_result") as { exitCode: number };
      const done = mine.find((e) => e.type === "done") as { exitCode: number };
      assert.ok(test && done, r.runId);
      if (r.outcome === "done") {
        assert.equal(test.exitCode, 0);
        assert.equal(done.exitCode, 0);
        assert.ok(!mine.some((e) => e.type === "stderr"));
      } else {
        assert.notEqual(test.exitCode, 0);
        assert.equal(done.exitCode, test.exitCode);
        assert.ok(mine.some((e) => e.type === "stderr"));
      }
    }
  });

  test("content is generic and fictional: the diff is a real unified diff of app/Example.php", () => {
    const found = evs.find((e) => e.event.type === "diff");
    assert.ok(found);
    const diff = (found.event as { diff: string }).diff;
    assert.match(diff, /^diff --git a\/app\/Example\.php b\/app\/Example\.php\n/);
    assert.match(diff, /\n@@ /);
  });

  test("the same plan always gives the same events", () => {
    assert.ok(evs.length > 0);
    assert.deepEqual(simulationEvents(plan), simulationEvents(plan));
  });
});

describe("allConcurrentWindow", () => {
  test("for 100 runs there is a window in which all 100 are between ready and done", () => {
    const evs = simulationEvents(planSimulation({ n: 100, seed: 42 }));
    const w = allConcurrentWindow(evs);
    assert.ok(w, "a window must exist");
    assert.ok(w.to > w.from);
    const ready = new Map<string, number>();
    const done = new Map<string, number>();
    for (const e of evs) {
      if (e.event.type === "sandbox_ready") ready.set(e.runId, e.at);
      if (e.event.type === "done") done.set(e.runId, e.at);
    }
    assert.equal(ready.size, 100);
    for (const [id, at] of ready) assert.ok(at <= w.from && done.get(id)! >= w.to, `${id} not alive across the window`);
  });

  test("a window exists for every n and several seeds, including n=200", () => {
    for (const [n, seed] of [[1, 1], [10, 2], [100, 3], [200, 4], [200, 5]] as const) {
      assert.ok(allConcurrentWindow(simulationEvents(planSimulation({ n, seed }))), `n=${n} seed=${seed}`);
    }
  });

  test("returns null when the runs never overlap", () => {
    const evs: SimEvent[] = [
      { at: 0, runId: "a", event: { type: "sandbox_ready", ts: 0, startupMs: 1 } },
      { at: 5, runId: "a", event: { type: "done", ts: 5, exitCode: 0 } },
      { at: 10, runId: "b", event: { type: "sandbox_ready", ts: 10, startupMs: 1 } },
      { at: 15, runId: "b", event: { type: "done", ts: 15, exitCode: 0 } },
    ];
    assert.equal(allConcurrentWindow(evs), null);
    const overlap: SimEvent[] = [
      { at: 0, runId: "a", event: { type: "sandbox_ready", ts: 0, startupMs: 1 } },
      { at: 4, runId: "b", event: { type: "sandbox_ready", ts: 4, startupMs: 1 } },
      { at: 10, runId: "a", event: { type: "done", ts: 10, exitCode: 0 } },
      { at: 12, runId: "b", event: { type: "done", ts: 12, exitCode: 0 } },
    ];
    assert.deepEqual(allConcurrentWindow(overlap), { from: 4, to: 10 });
  });
});
