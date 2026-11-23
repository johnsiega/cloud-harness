// Tests for model selection, Codex monitoring and batch statistics. Run: node --test scripts/monitoring.test.ts
// Pure functions only: no network, no AWS, no subprocesses.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as S from "./smoke-test.ts";

const MODEL = "deepseek/deepseek-v4.1-flash"; // hand-authored, not imported
const EDITED = "app/Services/QueueEventLog.php";
const IMAGE_ARN = "arn:aws:lambda:us-east-1:111122223333:microvm-image:hq-smoke";

// ---------- model override ----------
describe("model selection", () => {
  const base = { imageArn: IMAGE_ARN, repoUrl: "https://github.com/jyvnn/hospital-queue", task: "t", apiKey: "sk-or-v1-TESTKEY" };

  test("an explicit model lands in the run hook payload as MODEL", () => {
    const r = S.buildRunRequest({ ...base, model: "qwen/qwen3-coder-30b-a3b-instruct" });
    assert.equal(JSON.parse(r.runHookPayload).MODEL, "qwen/qwen3-coder-30b-a3b-instruct");
  });

  test("the default model is deepseek/deepseek-v4.1-flash when none is given", () => {
    assert.equal(JSON.parse(S.buildRunRequest(base).runHookPayload).MODEL, MODEL);
  });

  test("a malformed model id is rejected before any AWS call", () => {
    for (const bad of ["", "no-slash", "a/b c", "x/y;rm -rf /", "../etc/passwd", "a/b\nc"]) {
      assert.throws(() => S.buildRunRequest({ ...base, model: bad }), /model/i, JSON.stringify(bad));
    }
  });

  test("ids with dots, colons and dashes (deepseek/deepseek-v4.1-flash:batch) are accepted", () => {
    assert.doesNotThrow(() => S.buildRunRequest({ ...base, model: "deepseek/deepseek-v4.1-flash:batch" }));
  });
});

// ---------- Codex monitoring ----------
describe("codex monitoring", () => {
  const cmd = (exit: number | null, command = "/bin/bash -lc 'ls -la'") => ({ type: "item.completed", item: { type: "command_execution", command, exit_code: exit } });

  test("extractUsage reads token usage from turn.completed", () => {
    const ev = [{ type: "turn.completed", usage: { input_tokens: 155593, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 1577, reasoning_output_tokens: 4 } }];
    assert.deepEqual(S.extractUsage(ev), { inputTokens: 155593, cachedInputTokens: 10, outputTokens: 1577, reasoningTokens: 4 });
  });

  test("extractUsage sums several turns, and returns null when there is no usage", () => {
    const u = (i: number, o: number) => ({ type: "turn.completed", usage: { input_tokens: i, cached_input_tokens: 0, output_tokens: o, reasoning_output_tokens: 0 } });
    assert.deepEqual(S.extractUsage([u(100, 5), { type: "turn.started" }, u(50, 7)]), { inputTokens: 150, cachedInputTokens: 0, outputTokens: 12, reasoningTokens: 0 });
    assert.equal(S.extractUsage([{ type: "turn.completed" }, { type: "thread.started" }]), null);
    assert.equal(S.extractUsage([]), null);
  });

  test("summarizeCodexActivity counts finished commands, failed commands, file changes, messages, reasoning and item errors", () => {
    const ev = [
      { type: "item.started", item: { type: "command_execution", command: "x", exit_code: null } }, // started items do not count
      cmd(0), cmd(1), cmd(0),
      { type: "item.completed", item: { type: "file_change", changes: [{ path: "a.php", kind: "update" }] } },
      { type: "item.completed", item: { type: "agent_message", text: "hi" } },
      { type: "item.completed", item: { type: "agent_message", text: "again" } },
      { type: "item.completed", item: { type: "reasoning", text: "hmm" } },
      { type: "item.completed", item: { type: "error", message: "Model metadata not found" } },
      { type: "error", message: "top-level error is not an item error" },
    ];
    assert.deepEqual(S.summarizeCodexActivity(ev), { commands: 3, failedCommands: 1, fileChanges: 1, agentMessages: 2, reasoningItems: 1, itemErrors: 1 });
  });

  test("summarizeCodexActivity of nothing is all zeros", () => {
    assert.deepEqual(S.summarizeCodexActivity([]), { commands: 0, failedCommands: 0, fileChanges: 0, agentMessages: 0, reasoningItems: 0, itemErrors: 0 });
  });

  test("describeEvent renders one readable line per interesting event", () => {
    assert.equal(S.describeEvent(cmd(0)), "cmd exit=0: /bin/bash -lc 'ls -la'");
    assert.equal(S.describeEvent(cmd(127, "x".repeat(300))), `cmd exit=127: ${"x".repeat(99)}…`);
    assert.equal(S.describeEvent({ type: "item.completed", item: { type: "agent_message", text: "I'll add a comment" } }), "msg: I'll add a comment");
    assert.equal(
      S.describeEvent({ type: "item.completed", item: { type: "file_change", changes: [{ path: EDITED, kind: "update" }, { path: "app/New.php", kind: "add" }] } }),
      `file_change: ${EDITED} (update), app/New.php (add)`,
    );
    assert.equal(S.describeEvent({ type: "item.completed", item: { type: "reasoning", text: "thinking hard" } }), "reasoning: thinking hard");
    assert.equal(S.describeEvent({ type: "item.completed", item: { type: "error", message: "Model metadata not found" } }), "item_error: Model metadata not found");
    assert.equal(S.describeEvent({ type: "error", message: "404 model not found" }), "ERROR: 404 model not found");
    assert.equal(S.describeEvent({ type: "turn.failed", error: { message: "rejected" } }), "TURN_FAILED: rejected");
    assert.equal(
      S.describeEvent({ type: "turn.completed", usage: { input_tokens: 155593, cached_input_tokens: 0, output_tokens: 1577, reasoning_output_tokens: 0 } }),
      "turn.completed in=155593 out=1577 reasoning=0",
    );
  });

  test("describeEvent stays silent for bookkeeping events", () => {
    for (const e of [{ type: "thread.started" }, { type: "turn.started" }, { type: "item.started", item: { type: "command_execution" } }, { type: "codex_exit", exitCode: 0 }]) {
      assert.equal(S.describeEvent(e), null, JSON.stringify(e));
    }
  });
});

// ---------- batch statistics + artifacts ----------
describe("batch statistics", () => {
  const act = (fileChanges: number) => ({ commands: 1, failedCommands: 0, fileChanges, agentMessages: 1, reasoningItems: 0, itemErrors: 0 });
  const run = (o: Partial<S.RunResult>): S.RunResult => ({
    index: 1, model: MODEL, microvmId: "mvm-1", gatePassed: false, exitCode: 1, runMs: 0, submitToReadyMs: 0, submitToFirstReasoningMs: null,
    codexExit: 0, testExit: 0, diffBytes: 0, editedFilePresent: false, activity: act(0), usage: null, eventsRaw: "", diff: "", stderrTail: [], ...o,
  });
  const three = [
    run({ index: 1, gatePassed: true, exitCode: 0, runMs: 85480, submitToReadyMs: 3795, diffBytes: 3770, editedFilePresent: true, activity: act(1), usage: null }),
    run({ index: 2, runMs: 35896, submitToReadyMs: 4190, usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 } }),
    run({ index: 3, runMs: 35613, submitToReadyMs: 4451, usage: { inputTokens: 155593, cachedInputTokens: 0, outputTokens: 1577, reasoningTokens: 0 } }),
  ];

  test("summarizeRuns aggregates pass rate, empty diffs, timings and tokens over three runs", () => {
    assert.deepEqual(S.summarizeRuns(three), {
      runs: 3, passed: 1, passRate: 1 / 3, emptyDiffs: 2, codexFailures: 0, runsWithFileChange: 1,
      medianRunMs: 35896, minRunMs: 35613, maxRunMs: 85480, medianReadyMs: 4190, totalInputTokens: 155693, totalOutputTokens: 1587,
    });
  });

  test("summarizeRuns takes the mean of the middle two for an even count and counts exit-2 runs as codex failures", () => {
    const s = S.summarizeRuns([run({ runMs: 10000, exitCode: 2 }), run({ runMs: 20000, exitCode: 0, gatePassed: true, diffBytes: 5 })]);
    assert.equal(s.medianRunMs, 15000);
    assert.equal(s.codexFailures, 1);
    assert.equal(s.passed, 1);
  });

  test("summarizeRuns of no runs is all zeros, never NaN", () => {
    assert.deepEqual(Object.values(S.summarizeRuns([])), new Array(12).fill(0));
  });

  test("formatBatchSummary prints labelled lines with seconds and a percentage", () => {
    assert.deepEqual(S.formatBatchSummary(S.summarizeRuns(three), "deepseek/x").trim().split(/\r?\n/), [
      "model: deepseek/x",
      "runs: 3",
      "passed: 1/3 (33.3%)",
      "empty_diffs: 2",
      "codex_failures: 0",
      "runs_with_file_change: 1",
      "run_seconds_median: 35.896",
      "run_seconds_min: 35.613",
      "run_seconds_max: 85.48",
      "ready_seconds_median: 4.19",
      "input_tokens_total: 155693",
      "output_tokens_total: 1587",
    ]);
  });

  test("runArtifacts yields exactly the four per-run files with real content", () => {
    const r = run({ index: 2, microvmId: "mvm-9", eventsRaw: '{"type":"turn.started"}', diff: "diff --git a/f b/f\n", stderrTail: ["a", "b"], activity: act(1), gatePassed: true, exitCode: 0 });
    const a = S.runArtifacts(r);
    assert.deepEqual(Object.keys(a).sort(), ["diff.patch", "events.jsonl", "meta.json", "stderr.txt"]);
    assert.equal(a["events.jsonl"], '{"type":"turn.started"}\n');
    assert.equal(a["diff.patch"], "diff --git a/f b/f\n");
    assert.equal(a["stderr.txt"], "a\nb\n");
    const meta = JSON.parse(a["meta.json"]);
    assert.equal(meta.microvmId, "mvm-9");
    assert.equal(meta.model, MODEL);
    assert.equal(meta.gatePassed, true);
    assert.equal(meta.activity.fileChanges, 1);
    assert.ok(!("eventsRaw" in meta) && !("diff" in meta), "meta.json must not duplicate the big payloads");
  });
});
