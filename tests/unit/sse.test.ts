// SSE wire format. Run: node --test tests/unit/sse.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatSse } from "../../api/sse.ts";
import type { TraceEvent } from "../../api/types.ts";

// Minimal spec-compliant parser: split frames on a blank line, join multiple data lines with \n.
function parseSse(wire: string): { event: string; data: any }[] {
  return wire.split("\n\n").filter(Boolean).map((frame) => {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    return { event, data: JSON.parse(data.join("\n")) };
  });
}

describe("formatSse", () => {
  test("emits `event: <type>` then `data: <json>` then a blank line", () => {
    const e: TraceEvent = { type: "test_result", ts: 5, exitCode: 1, summary: "tests failed (exit 1)" };
    assert.equal(formatSse(e), 'event: test_result\ndata: {"type":"test_result","ts":5,"exitCode":1,"summary":"tests failed (exit 1)"}\n\n');
  });

  test("tags the payload with runId when one is given", () => {
    assert.equal(formatSse({ type: "done", ts: 9, exitCode: 0 }, "run-7"), 'event: done\ndata: {"runId":"run-7","type":"done","ts":9,"exitCode":0}\n\n');
  });

  test("a multi-line diff round-trips as exactly one event on one data line", () => {
    const diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1,2 @@\n a\n+b\n";
    const wire = formatSse({ type: "diff", ts: 1, diff });
    assert.equal(wire.split("\n").filter((l) => l.startsWith("data:")).length, 1);
    const parsed = parseSse(wire);
    assert.equal(parsed.length, 1, "exactly one frame expected");
    assert.equal(parsed[0].event, "diff");
    assert.equal(parsed[0].data.diff, diff);
  });

  test("text that looks like SSE framing cannot forge a second event", () => {
    const evil = "ok\n\nevent: done\ndata: {\"type\":\"done\"}\n\n";
    const parsed = parseSse(formatSse({ type: "stdout", ts: 1, text: evil }));
    assert.equal(parsed.length, 1, "exactly one frame expected");
    assert.equal(parsed[0].data.text, evil);
  });

  test("unicode, quotes and backslashes survive the round trip", () => {
    const text = 'naïve "quoted" \\ back — ✓';
    const frames = parseSse(formatSse({ type: "stdout", ts: 1, text }));
    assert.equal(frames.length, 1, "exactly one frame expected");
    assert.equal(frames[0].data.text, text);
  });

  test("several events concatenate into several frames in order", () => {
    const wire = formatSse({ type: "sandbox_resuming", ts: 1 }) + formatSse({ type: "sandbox_ready", ts: 2, startupMs: 3700 });
    assert.deepEqual(parseSse(wire).map((f) => f.event), ["sandbox_resuming", "sandbox_ready"]);
  });
});
