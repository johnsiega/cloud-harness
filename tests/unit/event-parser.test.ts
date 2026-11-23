// EventParser: runner stdout (Codex JSONL + runner events + diff block) -> TraceEvents. Run: node --test tests/unit/event-parser.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createEventParser } from "../../api/event-parser.ts";

const NOW = 7000;
const parser = () => createEventParser({ now: () => NOW });
const j = (o: unknown) => JSON.stringify(o) + "\n";
const DIFF = "diff --git a/f b/f\n--- a/f\n+++ b/f\n+x\n";

describe("EventParser", () => {
  test("a realistic run maps to exactly reasoning, stdout, test_result and diff events, in order", () => {
    const p = parser();
    const input =
      j({ type: "thread.started", thread_id: "t" }) +
      j({ type: "turn.started" }) +
      j({ type: "item.started", item: { type: "command_execution", command: "/bin/bash -lc 'ls'", aggregated_output: "", exit_code: null } }) +
      j({ type: "item.completed", item: { type: "agent_message", text: "I'll add a comment" } }) +
      j({ type: "item.completed", item: { type: "command_execution", command: "/bin/bash -lc 'ls'", aggregated_output: "a.php\nb.php\n", exit_code: 0 } }) +
      j({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } }) +
      j({ type: "codex_exit", ts: 1, exitCode: 0 }) +
      j({ type: "test_result", ts: 2, exitCode: 1 }) +
      "__DIFF_START__\n" + DIFF + "__DIFF_END__\n";
    assert.deepEqual(p.push(input), [
      { type: "reasoning", ts: NOW, text: "I'll add a comment" },
      { type: "stdout", ts: NOW, text: "$ /bin/bash -lc 'ls'\na.php\nb.php" },
      { type: "test_result", ts: NOW, exitCode: 1, summary: "tests failed (exit 1)" },
      { type: "diff", ts: NOW, diff: DIFF },
    ]);
    assert.equal(p.codexExit, 0);
  });

  test("a passing test_result carries the 'tests passed' summary", () => {
    assert.deepEqual(parser().push(j({ type: "test_result", exitCode: 0 })), [{ type: "test_result", ts: NOW, exitCode: 0, summary: "tests passed" }]);
  });

  test("codexExit is null until codex_exit arrives, then holds its exit code", () => {
    const p = parser();
    assert.equal(p.codexExit, null);
    p.push(j({ type: "codex_exit", exitCode: 2 }));
    assert.equal(p.codexExit, 2);
  });

  test("a reasoning item becomes a reasoning event", () => {
    assert.deepEqual(parser().push(j({ type: "item.completed", item: { type: "reasoning", text: "thinking" } })), [{ type: "reasoning", ts: NOW, text: "thinking" }]);
  });

  test("a command with no output renders as just the command line", () => {
    const e = parser().push(j({ type: "item.completed", item: { type: "command_execution", command: "true", aggregated_output: "", exit_code: 0 } }));
    assert.deepEqual(e, [{ type: "stdout", ts: NOW, text: "$ true" }]);
  });

  test("a file_change item becomes a stdout line listing path and kind", () => {
    const e = parser().push(j({ type: "item.completed", item: { type: "file_change", changes: [{ path: "app/X.php", kind: "update" }, { path: "n.php", kind: "add" }] } }));
    assert.deepEqual(e, [{ type: "stdout", ts: NOW, text: "file_change: app/X.php (update), n.php (add)" }]);
  });

  test("item-level errors, top-level errors and turn.failed become stderr events carrying the message", () => {
    const p = parser();
    assert.deepEqual(p.push(j({ type: "item.completed", item: { type: "error", message: "Model metadata not found" } })), [{ type: "stderr", ts: NOW, text: "Model metadata not found" }]);
    assert.deepEqual(p.push(j({ type: "error", message: "404 model not found" })), [{ type: "stderr", ts: NOW, text: "404 model not found" }]);
    assert.deepEqual(p.push(j({ type: "turn.failed", error: { message: "rejected" } })), [{ type: "stderr", ts: NOW, text: "rejected" }]);
  });

  test("bookkeeping events produce nothing", () => {
    const p = parser();
    for (const e of [{ type: "thread.started" }, { type: "turn.started" }, { type: "turn.completed" }, { type: "item.started", item: { type: "agent_message" } }]) {
      assert.deepEqual(p.push(j(e)), [], JSON.stringify(e));
    }
  });

  test("a non-JSON line outside the diff block is passed through as stdout", () => {
    assert.deepEqual(parser().push("some raw runner output\n"), [{ type: "stdout", ts: NOW, text: "some raw runner output" }]);
  });

  test("blank lines and CRLF line endings are tolerated", () => {
    const e = parser().push('\r\n{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\r\n\r\n');
    assert.deepEqual(e, [{ type: "reasoning", ts: NOW, text: "hi" }]);
  });

  test("a diff marker split across stdout chunks yields exactly one diff event", () => {
    const p = parser();
    const out = [
      ...p.push('{"type":"item.completed","item":{"type":"agent_message","te'),
      ...p.push('xt":"hello"}}\n__DIFF_STA'),
      ...p.push("RT__\ndiff --git a/f b/f\n+x\n__DIF"),
      ...p.push("F_END__\n"),
      ...p.end(),
    ];
    assert.deepEqual(out, [
      { type: "reasoning", ts: NOW, text: "hello" },
      { type: "diff", ts: NOW, diff: "diff --git a/f b/f\n+x\n" },
    ]);
  });

  test("JSON-looking lines inside the diff block are diff content, not events", () => {
    const p = parser();
    const e = p.push('__DIFF_START__\n{"type":"error","message":"x"}\n+  "type": "error"\n__DIFF_END__\n');
    assert.deepEqual(e, [{ type: "diff", ts: NOW, diff: '{"type":"error","message":"x"}\n+  "type": "error"\n' }]);
  });

  test("an empty diff block yields a diff event with an empty string", () => {
    assert.deepEqual(parser().push("__DIFF_START__\n__DIFF_END__\n"), [{ type: "diff", ts: NOW, diff: "" }]);
  });

  test("an unterminated diff block is reported on end() as stderr, and no diff event is produced", () => {
    const p = parser();
    assert.deepEqual(p.push("__DIFF_START__\ndiff --git a/f b/f\n+x\n"), []);
    assert.deepEqual(p.end(), [{ type: "stderr", ts: NOW, text: "diff block was not terminated" }]);
  });

  test("end() flushes a final complete line that had no trailing newline", () => {
    const p = parser();
    assert.deepEqual(p.push('{"type":"test_result","exitCode":0}'), []);
    assert.deepEqual(p.end(), [{ type: "test_result", ts: NOW, exitCode: 0, summary: "tests passed" }]);
  });

  test("events are stamped with the injected clock at the time of parsing", () => {
    let t = 100;
    const p = createEventParser({ now: () => t });
    const a = p.push(j({ type: "error", message: "a" }));
    t = 250;
    const b = p.push(j({ type: "error", message: "b" }));
    assert.equal(a.length + b.length, 2, "both errors must produce an event");
    assert.equal(a[0].ts, 100);
    assert.equal(b[0].ts, 250);
  });
});

describe("EventParser: base commit", () => {
  const SHA = "ea724cea11c755453e8d826872470b2448c1cca1";

  test("baseCommit is null until a base_commit event arrives, then holds its SHA, and the event itself yields nothing", () => {
    const p = parser();
    assert.equal(p.baseCommit, null);
    assert.deepEqual(p.push(j({ type: "base_commit", sha: SHA })), []);
    assert.equal(p.baseCommit, SHA);
  });

  test("a malformed SHA is ignored: short, uppercase, non-hex, wrong type, option-like, or extra characters", () => {
    for (const sha of ["ea724ce", SHA.toUpperCase(), "z".repeat(40), 42, null, "--upload-pack=x", SHA + "\n", SHA + "a", ""]) {
      const p = parser();
      p.push(j({ type: "base_commit", sha }));
      assert.equal(p.baseCommit, null, JSON.stringify(sha));
    }
  });

  test("the first valid base_commit wins, a later one cannot change it", () => {
    const p = parser();
    p.push(j({ type: "base_commit", sha: SHA }));
    p.push(j({ type: "base_commit", sha: "0".repeat(40) }));
    assert.equal(p.baseCommit, SHA);
  });
});
