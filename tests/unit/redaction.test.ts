// Redaction: exact secret values and known token prefixes never survive. Run: node --test tests/unit/redaction.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRedactor } from "../../api/redact.ts";
import type { TraceEvent } from "../../api/types.ts";

const KEY = "sk-or-v1-0123456789abcdef";
const PAT = "github_pat_11ABCDEFG_secretsecret";
const R = "[REDACTED]";

describe("Redactor.text", () => {
  const red = createRedactor([KEY, PAT]);

  test("replaces every occurrence of a registered secret", () => {
    assert.equal(red.text(`a ${KEY} b ${KEY}\nc ${PAT}`), `a ${R} b ${R}\nc ${R}`);
  });

  test("replaces known token prefixes even when the value was never registered", () => {
    assert.equal(red.text("x sk-or-v1-unregistered123 y"), `x ${R} y`);
    assert.equal(red.text("t github_pat_11ZZZ_other"), `t ${R}`);
    assert.equal(red.text("t ghp_AbCd1234EfGh"), `t ${R}`);
  });

  test("leaves text without secrets byte-for-byte unchanged", () => {
    const s = "diff --git a/f b/f\n+// uses sk- prefix in prose, ghp alone, and github_pat without underscore\n";
    assert.equal(red.text(s), s);
  });

  test("ignores empty secrets instead of mangling every character", () => {
    assert.equal(createRedactor(["", KEY]).text("abc"), "abc");
  });

  test("treats secrets literally, not as regular expressions", () => {
    const lit = createRedactor(["a.b*c(d)"]);
    assert.equal(lit.text("aXbbc(d) a.b*c(d)"), `aXbbc(d) ${R}`);
  });

  test("is idempotent", () => {
    assert.equal(red.text(red.text(`k=${KEY}`)), `k=${R}`);
  });
});

describe("Redactor.event", () => {
  const red = createRedactor([KEY]);

  test("redacts every string field of every event type and leaves numbers alone", () => {
    const evs: TraceEvent[] = [
      { type: "sandbox_resuming", ts: 1 },
      { type: "sandbox_ready", ts: 2, startupMs: 3700 },
      { type: "reasoning", ts: 3, text: `think ${KEY}` },
      { type: "stdout", ts: 4, text: `out ${KEY}` },
      { type: "stderr", ts: 5, text: `err ${KEY}` },
      { type: "test_result", ts: 6, exitCode: 1, summary: `failed ${KEY}` },
      { type: "diff", ts: 7, diff: `+${KEY}\n` },
      { type: "done", ts: 8, exitCode: 0 },
    ];
    const out = evs.map((e) => red.event(e));
    assert.ok(!JSON.stringify(out).includes(KEY));
    assert.deepEqual(out[2], { type: "reasoning", ts: 3, text: `think ${R}` });
    assert.deepEqual(out[5], { type: "test_result", ts: 6, exitCode: 1, summary: `failed ${R}` });
    assert.deepEqual(out[6], { type: "diff", ts: 7, diff: `+${R}\n` });
    assert.deepEqual(out[1], evs[1]);
    assert.deepEqual(out[7], evs[7]);
  });

  test("returns a new object and never mutates its input", () => {
    const e: TraceEvent = { type: "stdout", ts: 1, text: KEY };
    const out = red.event(e);
    assert.equal(e.type === "stdout" && e.text, KEY);
    assert.notEqual(out, e);
  });
});

describe("per-run keys: the management key", () => {
  // No sk-or- prefix here on purpose, so only the exact-value rule can catch it.
  const MGMT = "mgmt-0123456789abcdef-management";
  test("is redacted from text and events when it is in the secret list", () => {
    const r = createRedactor([KEY, MGMT]);
    assert.equal(r.text(`auth failed for ${MGMT}`), "auth failed for [REDACTED]");
    const e = r.event({ type: "stderr", ts: 1, text: `bad ${MGMT} and ${KEY}` });
    assert.equal((e as { text: string }).text, "bad [REDACTED] and [REDACTED]");
  });
});
