// UI state logic behind the three panels (Reasoning | Terminal | Diff). Run: node --test tests/unit/run-view.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { diffLines, formatMs, initialView, railSteps, reduce, testTone } from "../../web/src/run-view.ts";
import type { TraceEvent } from "../../api/types.ts";

const play = (events: TraceEvent[]) => events.reduce(reduce, initialView());

describe("initialView", () => {
  test("starts idle with empty panels and no metrics", () => {
    assert.deepEqual(initialView(), { phase: "idle", reasoning: [], terminal: [] });
  });
});

describe("reduce: lifecycle", () => {
  test("sandbox_resuming moves to resuming, sandbox_ready to ready and records startupMs", () => {
    const resuming = play([{ type: "sandbox_resuming", ts: 100 }]);
    assert.equal(resuming.phase, "resuming");
    const ready = reduce(resuming, { type: "sandbox_ready", ts: 150, startupMs: 2825 });
    assert.equal(ready.phase, "ready");
    assert.equal(ready.startupMs, 2825);
  });

  test("the first reasoning or stdout after ready moves the run to running", () => {
    const base = play([{ type: "sandbox_resuming", ts: 100 }, { type: "sandbox_ready", ts: 150, startupMs: 50 }]);
    assert.equal(reduce(base, { type: "reasoning", ts: 200, text: "x" }).phase, "running");
    assert.equal(reduce(base, { type: "stdout", ts: 200, text: "x" }).phase, "running");
  });

  test("output arriving before the sandbox is ready does not skip the ready phase", () => {
    const v = play([{ type: "sandbox_resuming", ts: 100 }, { type: "stdout", ts: 120, text: "early" }]);
    assert.equal(v.phase, "resuming");
    assert.equal(v.terminal.length, 1);
  });

  test("firstTokenMs is the first reasoning event's ts minus sandbox_resuming's ts, and is set only once", () => {
    const v = play([
      { type: "sandbox_resuming", ts: 1000 },
      { type: "sandbox_ready", ts: 1200, startupMs: 200 },
      { type: "reasoning", ts: 4500, text: "first" },
      { type: "reasoning", ts: 9000, text: "second" },
    ]);
    assert.equal(v.firstTokenMs, 3500);
  });

  test("firstTokenMs stays undefined when no reasoning ever arrives", () => {
    const v = play([{ type: "sandbox_resuming", ts: 1 }, { type: "stdout", ts: 2, text: "x" }]);
    assert.equal(v.firstTokenMs, undefined);
  });

  test("done with exit code 0 ends as done; any other exit code ends as error; both keep the exit code", () => {
    const ok = reduce(initialView(), { type: "done", ts: 1, exitCode: 0 });
    assert.deepEqual([ok.phase, ok.exitCode], ["done", 0]);
    const bad = reduce(initialView(), { type: "done", ts: 1, exitCode: 1 });
    assert.deepEqual([bad.phase, bad.exitCode], ["error", 1]);
  });
});

describe("reduce: panels", () => {
  test("reasoning events append to the Reasoning panel in order, keeping ts and text", () => {
    const v = play([{ type: "reasoning", ts: 1, text: "a" }, { type: "reasoning", ts: 2, text: "b" }]);
    assert.deepEqual(v.reasoning, [{ ts: 1, text: "a" }, { ts: 2, text: "b" }]);
    assert.deepEqual(v.terminal, []);
  });

  test("stdout and stderr append to the Terminal panel with their kind, interleaved in arrival order", () => {
    const v = play([{ type: "stdout", ts: 1, text: "out" }, { type: "stderr", ts: 2, text: "err" }, { type: "stdout", ts: 3, text: "out2" }]);
    assert.deepEqual(v.terminal, [
      { ts: 1, kind: "stdout", text: "out" },
      { ts: 2, kind: "stderr", text: "err" },
      { ts: 3, kind: "stdout", text: "out2" },
    ]);
    assert.deepEqual(v.reasoning, []);
  });

  test("test_result is recorded with its exit code and summary", () => {
    const v = play([{ type: "test_result", ts: 1, exitCode: 1, summary: "tests failed (exit 1)" }]);
    assert.deepEqual(v.test, { exitCode: 1, summary: "tests failed (exit 1)" });
  });

  test("a diff event fills the Diff panel, including an empty diff", () => {
    assert.equal(play([{ type: "diff", ts: 1, diff: "diff --git a/f b/f\n+x\n" }]).diff, "diff --git a/f b/f\n+x\n");
    assert.equal(play([{ type: "diff", ts: 1, diff: "" }]).diff, "");
  });

  test("reduce never mutates the previous view", () => {
    const before = initialView();
    const snapshot = JSON.stringify(before);
    reduce(before, { type: "reasoning", ts: 1, text: "x" });
    reduce(before, { type: "stdout", ts: 1, text: "x" });
    assert.equal(JSON.stringify(before), snapshot);
  });

  test("a full successful run ends with every panel filled", () => {
    const v = play([
      { type: "sandbox_resuming", ts: 1000 },
      { type: "sandbox_ready", ts: 1100, startupMs: 100 },
      { type: "reasoning", ts: 2000, text: "Adding the comment" },
      { type: "stdout", ts: 2100, text: "$ sed -i ..." },
      { type: "test_result", ts: 3000, exitCode: 0, summary: "tests passed" },
      { type: "diff", ts: 3100, diff: "diff --git a/f b/f\n+x\n" },
      { type: "done", ts: 3200, exitCode: 0 },
    ]);
    assert.equal(v.phase, "done");
    assert.equal(v.reasoning.length, 1);
    assert.equal(v.terminal.length, 1);
    assert.equal(v.test?.exitCode, 0);
    assert.equal(v.diff, "diff --git a/f b/f\n+x\n");
    assert.deepEqual([v.startupMs, v.firstTokenMs, v.exitCode], [100, 1000, 0]);
  });
});

describe("diffLines", () => {
  test("classifies headers, hunks, additions, deletions and context", () => {
    const diff = [
      "diff --git a/f.php b/f.php",
      "index dbb2316..93ade23 100644",
      "--- a/f.php",
      "+++ b/f.php",
      "@@ -25,6 +25,7 @@ public function __construct()",
      "     }",
      " ",
      "+    /** doc */",
      "-    old();",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    assert.deepEqual(diffLines(diff), [
      { kind: "meta", text: "diff --git a/f.php b/f.php" },
      { kind: "meta", text: "index dbb2316..93ade23 100644" },
      { kind: "meta", text: "--- a/f.php" },
      { kind: "meta", text: "+++ b/f.php" },
      { kind: "hunk", text: "@@ -25,6 +25,7 @@ public function __construct()" },
      { kind: "ctx", text: "     }" },
      { kind: "ctx", text: " " },
      { kind: "add", text: "+    /** doc */" },
      { kind: "del", text: "-    old();" },
      { kind: "ctx", text: "\\ No newline at end of file" },
    ]);
  });

  test("a deleted line that itself starts with dashes is a deletion, not a header", () => {
    assert.deepEqual(diffLines("@@ -1 +0,0 @@\n--- a comment\n"), [
      { kind: "hunk", text: "@@ -1 +0,0 @@" },
      { kind: "del", text: "--- a comment" },
    ]);
  });

  test("new/deleted file mode lines are meta, and an empty diff has no lines", () => {
    assert.deepEqual(diffLines("diff --git a/n b/n\nnew file mode 100644\n"), [
      { kind: "meta", text: "diff --git a/n b/n" },
      { kind: "meta", text: "new file mode 100644" },
    ]);
    assert.deepEqual(diffLines(""), []);
  });

  test("CRLF line endings do not leak a carriage return into the text", () => {
    assert.deepEqual(diffLines("+a\r\n-b\r\n"), [{ kind: "add", text: "+a" }, { kind: "del", text: "-b" }]);
  });
});

describe("formatMs", () => {
  test("renders sub-second values in ms and longer ones in seconds with one decimal", () => {
    assert.equal(formatMs(850), "850 ms");
    assert.equal(formatMs(999), "999 ms");
    assert.equal(formatMs(1000), "1.0 s");
    assert.equal(formatMs(2825), "2.8 s");
    assert.equal(formatMs(11321), "11.3 s");
    assert.equal(formatMs(0), "0 ms");
  });

  test("renders an em dash for a missing or invalid value", () => {
    assert.equal(formatMs(undefined), "—");
    assert.equal(formatMs(NaN), "—");
    assert.equal(formatMs(-5), "—");
  });
});

const PASSED: TraceEvent = { type: "test_result", ts: 4, exitCode: 0, summary: "tests passed" };
const FAILED: TraceEvent = { type: "test_result", ts: 4, exitCode: 1, summary: "tests failed (exit 1)" };
const SKIPPED: TraceEvent = { type: "test_result", ts: 4, exitCode: 0, summary: "tests not run: no tests found", skipped: "no tests found" };
const finished = (t: TraceEvent) => play([{ type: "sandbox_resuming", ts: 1 }, { type: "sandbox_ready", ts: 2, startupMs: 1500 }, { type: "reasoning", ts: 3, text: "x" }, t,
  { type: "diff", ts: 5, diff: "diff --git a/f b/f\n+a\n-b\n" }, { type: "done", ts: 6, exitCode: (t as any).exitCode }]);
// Asserts instead of using `!`, so the red run against the [] stub fails on an assertion, not a TypeError.
const step = (v: ReturnType<typeof play>, key: string) => { const s = railSteps(v).find((x) => x.key === key); assert.ok(s, `no ${key} step`); return s; };

describe("test_result: skipped in the view", () => {
  test("the reducer keeps the skipped reason; passed and failed results have no skipped key", () => {
    assert.deepEqual(finished(SKIPPED).test, { exitCode: 0, summary: "tests not run: no tests found", skipped: "no tests found" });
    assert.deepEqual(finished(PASSED).test, { exitCode: 0, summary: "tests passed" });
  });
  test("testTone: passed is ok, failed is fail, skipped is skip", () => {
    assert.equal(testTone(finished(PASSED).test), "ok");
    assert.equal(testTone(finished(FAILED).test), "fail");
    assert.equal(testTone(finished(SKIPPED).test), "skip");
  });
});

describe("railSteps (moved from RunRail.tsx; existing behaviour pinned)", () => {
  test("tests step: passed, failed with the exit code, and grey 'Tests not run' with the reason, never ok", () => {
    assert.deepEqual(step(finished(PASSED), "tests"), { key: "tests", label: "Tests passed", tone: "ok", detail: undefined });
    assert.deepEqual(step(finished(FAILED), "tests"), { key: "tests", label: "Tests failed", tone: "fail", detail: "exit 1" });
    assert.deepEqual(step(finished(SKIPPED), "tests"), { key: "tests", label: "Tests not run", tone: "skip", detail: "no tests found" });
  });
  test("four steps in order; the sandbox step shows the startup time; the patch counts lines", () => {
    const v = finished(PASSED);
    assert.deepEqual(railSteps(v).map((s) => s.key), ["sandbox", "agent", "tests", "patch"]);
    assert.equal(step(v, "sandbox").hero, "1.5 s");
    assert.deepEqual(step(v, "patch"), { key: "patch", label: "Patch ready", tone: "ok", detail: "+1 −1" });
  });
  test("before anything happens every step is pending; a finished run with no test result marks tests as failed", () => {
    assert.ok(railSteps(play([])).length === 4 && railSteps(play([])).every((s) => s.tone === "pending"));
    const noTest = play([{ type: "sandbox_resuming", ts: 1 }, { type: "sandbox_ready", ts: 2, startupMs: 1 }, { type: "reasoning", ts: 3, text: "x" }, { type: "done", ts: 4, exitCode: 1 }]);
    assert.equal(step(noTest, "tests").tone, "fail");
  });
});
