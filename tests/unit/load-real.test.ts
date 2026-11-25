// scripts/load-real.ts with a fake control plane: nothing here starts a MicroVM. Run: node --test tests/unit/load-real.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatReport, runLoad, runStep, summarizeRun, taskFor } from "../../scripts/load-real.ts";
import type { LoadDeps, LoadReport } from "../../scripts/load-real.ts";

type Script = { polls?: number; outcome?: "done" | "error" | "quota" | "never" | "reject409" | "reject503" };

const DIFF = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1,2 @@\n a\n+b\n";

// A fake control plane. `script(step, i)` says how run i of the current step behaves; `step` counts kill-all calls so far.
function world(script: (step: number, i: number) => Script = () => ({}), o: { throwOnPost?: boolean } = {}) {
  let t = 0;
  let step = 0;
  let next = 0;
  const log: string[] = [];
  const posts: { at: number; task: string; step: number }[] = [];
  const runs = new Map<string, { script: Script; polls: number }>();
  const deps: LoadDeps = {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    killAll: async () => { log.push(`kill-all after step ${step}`); step++; next = 0; },
    http: async (method, path, body: any) => {
      if (method === "POST") {
        assert.equal(path, "/runs");
        if (o.throwOnPost) throw new Error("connect ECONNREFUSED");
        const i = next++;
        posts.push({ at: t, task: body.task, step });
        const sc = script(step, i);
        if (sc.outcome === "reject409") return { status: 409, json: { error: "duplicate run in progress" } };
        if (sc.outcome === "reject503") return { status: 503, json: { error: "demo mode" } };
        const id = `run-${step}-${i}`;
        runs.set(id, { script: sc, polls: 0 });
        log.push(`post ${id}`);
        return { status: 202, json: { id } };
      }
      const r = runs.get(path.split("/").pop()!);
      assert.ok(r, `GET for an unknown run: ${path}`);
      r.polls++;
      const outcome = r.script.outcome ?? "done";
      if (outcome === "never" || r.polls <= (r.script.polls ?? 3)) return { status: 200, json: { status: "running", events: [] } };
      if (outcome === "quota") return { status: 200, json: { status: "error", events: [{ type: "stderr", text: "ServiceQuotaExceededException: memory quota reached" }, { type: "done", exitCode: 1 }] } };
      if (outcome === "error") return { status: 200, json: { status: "error", events: [{ type: "stderr", text: "tests failed" }] } };
      return { status: 200, json: { status: "done", startupMs: 1900, firstTokenMs: 8200, diff: DIFF, events: [{ type: "reasoning", text: "first" }, { type: "reasoning", text: "Added the comment above enabled()." }] } };
    },
  };
  return { deps, log, posts };
}

describe("taskFor", () => {
  test("gives a distinct, deterministic task per run, each about enabled()", () => {
    const tasks = Array.from({ length: 8 }, (_, i) => taskFor(i));
    assert.equal(new Set(tasks).size, 8, "the control plane rejects duplicate (repo, task) pairs, so tasks must differ");
    assert.deepEqual(tasks, Array.from({ length: 8 }, (_, i) => taskFor(i)));
    for (const t of tasks) assert.ok(t.includes("enabled()") && t.length > 20 && t.length < 500, JSON.stringify(t));
  });
});

describe("summarizeRun", () => {
  const rec = { status: "done", startupMs: 1900, firstTokenMs: 8200, diff: "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n-old\n+new1\n+new2\n", events: [{ type: "reasoning", text: "first" }, { type: "reasoning", text: "last message" }] };

  test("copies startup, first output and the elapsed time, and takes the last reasoning message", () => {
    const s = summarizeRun(1, rec, 41_000);
    assert.deepEqual({ index: s.index, status: s.status, startupMs: s.startupMs, firstOutputMs: s.firstOutputMs, durationMs: s.durationMs, finalMessage: s.finalMessage, quota: s.quota },
      { index: 1, status: "done", startupMs: 1900, firstOutputMs: 8200, durationMs: 41_000, finalMessage: "last message", quota: false });
  });

  test("counts added and removed diff lines, not the +++ and --- file headers", () => {
    const s = summarizeRun(0, rec, 1);
    assert.equal(s.diffAdded, 2);
    assert.equal(s.diffRemoved, 1);
  });

  test("a long final message is cut to 200 characters", () => {
    assert.equal(summarizeRun(0, { ...rec, events: [{ type: "reasoning", text: "x".repeat(500) }] }, 1).finalMessage?.length, 200);
  });

  test("an error record keeps its last stderr text, and a quota message sets quota", () => {
    const e = summarizeRun(0, { status: "error", events: [{ type: "stderr", text: "tests failed" }] }, 1);
    assert.deepEqual({ status: e.status, error: e.error, quota: e.quota }, { status: "error", error: "tests failed", quota: false });
    assert.equal(summarizeRun(0, { status: "error", events: [{ type: "stderr", text: "ServiceQuotaExceededException: memory quota reached" }] }, 1).quota, true);
  });

  test("missing optional fields stay undefined", () => {
    const s = summarizeRun(0, { status: "error", events: [] }, 5);
    assert.equal(s.status, "error");
    assert.equal(s.durationMs, 5);
    assert.equal(s.startupMs, undefined);
    assert.equal(s.diffAdded, undefined);
    assert.equal(s.finalMessage, undefined);
  });
});

describe("runStep", () => {
  test("starts k runs with distinct tasks, at least 250 ms apart, and reports every one finished", async () => {
    const w = world();
    const r = await runStep(w.deps, 3);
    assert.equal(r.k, 3);
    assert.deepEqual(r.runs.map((x) => x.status), ["done", "done", "done"]);
    assert.equal(r.ok, true);
    assert.equal(r.quota, false);
    assert.equal(new Set(w.posts.map((p) => p.task)).size, 3);
    for (let i = 1; i < w.posts.length; i++) assert.ok(w.posts[i].at - w.posts[i - 1].at >= 250, `posts ${i - 1} and ${i} too close`);
  });

  test("keeps polling until each run is done, so a slower run reports a longer duration", async () => {
    const w = world((_s, i) => ({ polls: 2 + i * 5 }));
    const r = await runStep(w.deps, 3);
    assert.deepEqual(r.runs.map((x) => x.status), ["done", "done", "done"]);
    assert.ok(r.runs[2].durationMs! > r.runs[0].durationMs!);
  });

  test("a run that never finishes is reported as timeout after runTimeoutMs, and the step is not ok", async () => {
    const w = world((_s, i) => (i === 1 ? { outcome: "never" } : {}));
    const r = await runStep(w.deps, 2, { runTimeoutMs: 20_000, pollMs: 1000 });
    assert.deepEqual(r.runs.map((x) => x.status), ["done", "timeout"]);
    assert.equal(r.ok, false);
  });

  test("a rejected submission (409 or 503) is reported as rejected with the reason, and the other runs still go", async () => {
    const w = world((_s, i) => (i === 0 ? { outcome: "reject409" } : {}));
    const r = await runStep(w.deps, 2);
    assert.equal(r.runs.length, 2);
    assert.equal(r.runs[0].status, "rejected");
    assert.match(r.runs[0].error ?? "", /duplicate/);
    assert.equal(r.runs[1].status, "done");
    assert.equal(r.ok, false);
  });

  test("a run that fails with a quota error sets the step's quota flag", async () => {
    const w = world((_s, i) => (i === 2 ? { outcome: "quota" } : {}));
    const r = await runStep(w.deps, 3);
    assert.equal(r.runs.length, 3);
    assert.equal(r.runs[2].status, "error");
    assert.equal(r.runs[2].quota, true);
    assert.equal(r.quota, true);
    assert.equal(r.ok, false);
  });
});

describe("runLoad", () => {
  test("steps up 2, 3, 4 with everything succeeding: highest is 4 and it stopped at the limit", async () => {
    const w = world();
    const r = await runLoad(w.deps, { startK: 2, maxK: 4 });
    assert.deepEqual(r.steps.map((s) => s.k), [2, 3, 4]);
    assert.equal(r.highestFullySucceeded, 4);
    assert.equal(r.stoppedBy, "max");
  });

  test("defaults: starts at 2 and goes up to 5", async () => {
    const r = await runLoad(world().deps);
    assert.deepEqual(r.steps.map((s) => s.k), [2, 3, 4, 5]);
  });

  test("kill-all runs after every step, and finishes before the next step starts any run", async () => {
    const w = world();
    await runLoad(w.deps, { startK: 2, maxK: 3 });
    assert.deepEqual(w.log.filter((l) => l.startsWith("kill-all")), ["kill-all after step 0", "kill-all after step 1"]);
    assert.ok(w.log.indexOf("kill-all after step 0") < w.log.indexOf("post run-1-0"), w.log.join(" | "));
    assert.equal(w.log.at(-1), "kill-all after step 1", "the last thing that happens is a final kill-all");
  });

  test("stops at the first quota error: no larger step is tried, and the highest is the last full success", async () => {
    const w = world((step, i) => (step === 2 && i === 3 ? { outcome: "quota" } : {}));
    const r = await runLoad(w.deps, { startK: 2, maxK: 6 });
    assert.deepEqual(r.steps.map((s) => s.k), [2, 3, 4]);
    assert.equal(r.highestFullySucceeded, 3);
    assert.equal(r.stoppedBy, "quota");
    assert.equal(w.log.filter((l) => l.startsWith("kill-all")).length, 3);
  });

  test("stops at a non-quota failure too, reporting it as a failure and not as the quota", async () => {
    const w = world((step, i) => (step === 1 && i === 0 ? { outcome: "error" } : {}));
    const r = await runLoad(w.deps, { startK: 2, maxK: 5 });
    assert.deepEqual(r.steps.map((s) => s.k), [2, 3]);
    assert.equal(r.highestFullySucceeded, 2);
    assert.equal(r.stoppedBy, "failure");
  });

  test("if the first step already fails, the highest fully successful K is 0", async () => {
    const r = await runLoad(world(() => ({ outcome: "error" })).deps, { startK: 2, maxK: 5 });
    assert.equal(r.steps.length, 1);
    assert.equal(r.highestFullySucceeded, 0);
    assert.equal(r.stoppedBy, "failure");
  });

  test("kill-all still runs when the control plane cannot be reached, and the error is passed on", async () => {
    const w = world(() => ({}), { throwOnPost: true });
    await assert.rejects(runLoad(w.deps, { startK: 2, maxK: 3 }), /ECONNREFUSED/);
    assert.ok(w.log.some((l) => l.startsWith("kill-all")), "cleanup must run even on a crash");
  });
});

describe("formatReport", () => {
  const report: LoadReport = {
    steps: [
      { k: 2, ok: true, quota: false, runs: [
        { index: 0, runId: "a", status: "done", startupMs: 1900, firstOutputMs: 8200, durationMs: 41_000, diffAdded: 2, diffRemoved: 1, finalMessage: "Added the comment.", quota: false },
        { index: 1, runId: "b", status: "done", startupMs: 2100, firstOutputMs: 9000, durationMs: 43_500, diffAdded: 1, diffRemoved: 0, quota: false },
      ] },
      { k: 3, ok: false, quota: true, runs: [{ index: 2, status: "error", error: "ServiceQuotaExceededException: memory quota reached", quota: true }] },
    ],
    highestFullySucceeded: 2,
    stoppedBy: "quota",
  };

  test("shows each run's status, startup, first output, duration, diff size and final message", () => {
    const text = formatReport(report);
    assert.match(text, /1\.9 s/);
    assert.match(text, /8\.2 s/);
    assert.match(text, /41\.0 s/);
    assert.match(text, /\+2 -1/);
    assert.match(text, /Added the comment\./);
    assert.match(text, /memory quota reached/);
  });

  test("states the highest K that fully succeeded and why it stopped", () => {
    const text = formatReport(report);
    assert.match(text, /Highest K that fully succeeded: 2/);
    assert.match(text, /stopped.*quota/i);
  });

  test("says these are real runs, and a report with no steps says nothing ran", () => {
    assert.match(formatReport(report), /real/i);
    assert.match(formatReport({ steps: [], highestFullySucceeded: 0, stoppedBy: "failure" }), /no steps/i);
  });
});
