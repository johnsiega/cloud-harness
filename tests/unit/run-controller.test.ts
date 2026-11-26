// executeRun: the control plane's run loop with a fake launcher and real store/parser/redactor.
// Run: node --test tests/unit/run-controller.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { executeRun } from "../../api/run-controller.ts";
import { createRunStore } from "../../api/run-store.ts";
import { createRedactor } from "../../api/redact.ts";
import { formatSse } from "../../api/sse.ts";
import type { MicroVMLauncher, SandboxHandle } from "../../api/types.ts";

const KEY = "sk-or-v1-CONTROLLERKEY-0123456789";
const REQ = { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "add a comment" };
const HANDLE: SandboxHandle = { microvmId: "mvm-1", endpoint: "e.on.aws", authToken: "tok", submitMs: 1000, readyMs: 1200 };
const DIFF = ["diff --git a/app/Services/QueueEventLog.php b/app/Services/QueueEventLog.php", "+    /** x */"];
const J = (o: unknown) => JSON.stringify(o);

const msg = (text: string) => J({ type: "item.completed", item: { type: "agent_message", text } });
const cmd = (command: string, out: string) => J({ type: "item.completed", item: { type: "command_execution", command, aggregated_output: out, exit_code: 0 } });
const codexExit = (n: number) => J({ type: "codex_exit", exitCode: n });
const testResult = (n: number) => J({ type: "test_result", exitCode: n });
const diffBlock = (lines = DIFF) => ["__DIFF_START__", ...lines, "__DIFF_END__"];

function fake(o: { chunks?: string[][]; never?: boolean; stderrTail?: string[]; exitCode?: number; launchError?: Error; startError?: Error; pollError?: Error } = {}) {
  const calls = { launch: 0, start: 0, poll: [] as number[], terminate: 0 };
  let i = 0;
  let next = 0;
  const chunks = o.chunks ?? [[]];
  const launcher: MicroVMLauncher = {
    launch: async () => { calls.launch++; if (o.launchError) throw o.launchError; return HANDLE; },
    start: async () => { calls.start++; if (o.startError) throw o.startError; },
    poll: async (_h, since) => {
      calls.poll.push(since);
      if (o.pollError) throw o.pollError;
      const lines = o.never ? [] : (chunks[i] ?? []);
      i++;
      next += lines.length;
      const done = !o.never && i >= chunks.length;
      return { lines, next, done, exitCode: done ? (o.exitCode ?? 0) : null, stderrTail: done ? (o.stderrTail ?? []) : [] };
    },
    terminate: async () => { calls.terminate++; },
  };
  return { launcher, calls };
}

async function run(f: ReturnType<typeof fake>, o: { maxPolls?: number } = {}) {
  let n = 0;
  const store = createRunStore({ now: () => 500, ttlMs: 1e9, newId: () => `run-${++n}` });
  const created = store.create(REQ);
  assert.ok(created.ok);
  const id = (created as any).record.id as string;
  let sleeps = 0;
  await executeRun(
    { store, launcher: f.launcher, redact: createRedactor([KEY]), now: () => 5000, sleep: async () => { sleeps++; }, pollMs: 10, maxPolls: o.maxPolls ?? 50 },
    id,
  );
  const rec = store.get(id)!;
  return { rec, store, id, sleeps, types: rec.events.map((e) => e.type), sse: rec.events.map((e) => formatSse(e, id)).join("") };
}

const HAPPY = [[msg("Adding the comment"), cmd("/bin/bash -lc 'sed -i ...'", "ok"), codexExit(0)], [testResult(0), ...diffBlock()]];

describe("executeRun: success path", () => {
  test("emits sandbox_resuming, sandbox_ready, the parsed trace, test_result, diff, then done, and ends as done", async () => {
    const r = await run(fake({ chunks: HAPPY }));
    assert.deepEqual(r.types, ["sandbox_resuming", "sandbox_ready", "reasoning", "stdout", "test_result", "diff", "done"]);
    assert.equal(r.rec.status, "done");
    assert.deepEqual(r.rec.events.at(-1), { type: "done", ts: 5000, exitCode: 0 });
  });

  test("records startupMs (ready - submit), firstTokenMs (first reasoning - submit), microvmId and the diff", async () => {
    const r = await run(fake({ chunks: HAPPY }));
    assert.equal(r.rec.startupMs, 200);
    assert.deepEqual(r.rec.events[1], { type: "sandbox_ready", ts: 5000, startupMs: 200 });
    assert.equal(r.rec.firstTokenMs, 4000);
    assert.equal(r.rec.microvmId, "mvm-1");
    assert.equal(r.rec.diff, DIFF.join("\n") + "\n");
  });

  test("polls with the running line offset, sleeping between polls, and terminates exactly once", async () => {
    const f = fake({ chunks: HAPPY });
    const r = await run(f);
    assert.deepEqual(f.calls.poll, [0, 3]);
    assert.equal(f.calls.terminate, 1);
    assert.equal(f.calls.start, 1);
    assert.ok(r.sleeps >= 1);
  });

  test("the record is already 'running' and shows sandbox_resuming while the launch is still in flight", async () => {
    let n = 0;
    const store = createRunStore({ now: () => 500, ttlMs: 1e9, newId: () => `run-${++n}` });
    const created = store.create(REQ);
    assert.ok(created.ok, "create must succeed");
    const id = (created as any).record.id as string;
    let during: any;
    const f = fake({ chunks: HAPPY });
    const orig = f.launcher.launch;
    f.launcher.launch = async (req) => { during = store.get(id); return orig(req); };
    await executeRun({ store, launcher: f.launcher, redact: createRedactor([KEY]), now: () => 5000, sleep: async () => {}, pollMs: 10, maxPolls: 5 }, id);
    assert.ok(during, "launch must be called");
    assert.equal(during.status, "running");
    assert.deepEqual(during.events.map((e: any) => e.type), ["sandbox_resuming"]);
  });

  test("launch gets the run id, which names the run's per-run OpenRouter key", async () => {
    const f = fake({ chunks: HAPPY });
    const seen: unknown[][] = [];
    const orig = f.launcher.launch;
    f.launcher.launch = async (...args: Parameters<typeof orig>) => { seen.push(args); return orig(...args); };
    const r = await run(f);
    assert.equal(seen.length, 1, "launch must be called once");
    assert.equal(seen[0][1], r.id);
  });
});

describe("executeRun: base commit", () => {
  const SHA = "ea724cea11c755453e8d826872470b2448c1cca1";
  const BASE = J({ type: "base_commit", sha: SHA });

  test("records the runner's base commit on the run without adding a trace event", async () => {
    const r = await run(fake({ chunks: [[BASE, msg("Adding the comment"), codexExit(0)], [testResult(0), ...diffBlock()]] }));
    assert.equal(r.rec.baseCommit, SHA);
    assert.deepEqual(r.types, ["sandbox_resuming", "sandbox_ready", "reasoning", "test_result", "diff", "done"]);
  });

  test("a run whose runner never reported a base commit has none recorded", async () => {
    const r = await run(fake({ chunks: HAPPY }));
    assert.equal(r.rec.baseCommit, undefined);
  });

  test("the base commit is kept even when the run fails afterwards", async () => {
    const r = await run(fake({ chunks: [[BASE, codexExit(2), testResult(1), ...diffBlock()]] }));
    assert.equal(r.rec.status, "error");
    assert.equal(r.rec.baseCommit, SHA);
  });
});

describe("executeRun: failure paths", () => {
  test("codex exits 0 but tests exit 1: status error, test_result.exitCode 1, done.exitCode 1, and SSE shows it", async () => {
    const r = await run(fake({ chunks: [[msg("done"), codexExit(0), testResult(1), ...diffBlock()]] }));
    assert.equal(r.rec.status, "error");
    const tr = r.rec.events.find((e) => e.type === "test_result") as any;
    assert.equal(tr.exitCode, 1);
    assert.equal(tr.summary, "tests failed (exit 1)");
    assert.deepEqual(r.rec.events.at(-1), { type: "done", ts: 5000, exitCode: 1 });
    assert.match(r.sse, /event: test_result\ndata: \{[^\n]*"exitCode":1/);
    assert.match(r.sse, /event: done\ndata: \{[^\n]*"exitCode":1/);
  });

  test("a non-zero codex exit makes the run an error even when tests pass", async () => {
    const r = await run(fake({ chunks: [[codexExit(2), testResult(0), ...diffBlock()]] }));
    assert.equal(r.rec.status, "error");
  });

  test("an empty diff is an error with an explanatory stderr event", async () => {
    const r = await run(fake({ chunks: [[codexExit(0), testResult(0), ...diffBlock([])]] }));
    assert.equal(r.rec.status, "error");
    assert.ok(r.rec.events.some((e) => e.type === "stderr" && /no changes/i.test(e.text)));
  });

  test("a missing diff block is an error too", async () => {
    const r = await run(fake({ chunks: [[codexExit(0), testResult(0)]] }));
    assert.equal(r.rec.status, "error");
  });

  test("a launch failure ends as error with sandbox_resuming, a stderr message and done(1); nothing to terminate", async () => {
    const f = fake({ launchError: new Error("AccessDenied: lambda:RunMicrovm") });
    const r = await run(f);
    assert.deepEqual(r.types, ["sandbox_resuming", "stderr", "done"]);
    assert.equal(r.rec.status, "error");
    assert.match((r.rec.events[1] as any).text, /AccessDenied/);
    assert.equal((r.rec.events[2] as any).exitCode, 1);
    assert.equal(f.calls.terminate, 0);
  });

  test("a failure after launch still terminates the MicroVM", async () => {
    for (const f of [fake({ startError: new Error("runner said 412") }), fake({ pollError: new Error("ECONNRESET") })]) {
      const r = await run(f);
      assert.equal(r.rec.status, "error");
      assert.equal(f.calls.terminate, 1);
      assert.equal((r.rec.events.at(-1) as any).type, "done");
    }
  });

  test("a run that never finishes times out after maxPolls with an error, and terminates", async () => {
    const f = fake({ never: true });
    const r = await run(f, { maxPolls: 3 });
    assert.equal(f.calls.poll.length, 3);
    assert.equal(r.rec.status, "error");
    assert.ok(r.rec.events.some((e) => e.type === "stderr" && /timed out/i.test(e.text)));
    assert.equal(f.calls.terminate, 1);
  });

  test("a codex model failure surfaces as stderr events and an error run", async () => {
    const r = await run(fake({ chunks: [[J({ type: "error", message: "404 model not found" }), J({ type: "turn.failed", error: { message: "rejected" } }), codexExit(1), testResult(0), ...diffBlock()]] }));
    assert.equal(r.rec.status, "error");
    assert.deepEqual(r.rec.events.filter((e) => e.type === "stderr").map((e: any) => e.text), ["404 model not found", "rejected"]);
  });

  test("executeRun never rejects, whatever the launcher does", async () => {
    await assert.doesNotReject(run(fake({ launchError: new Error("boom") })));
    await assert.doesNotReject(run(fake({ pollError: new Error("boom") })));
  });
});

describe("executeRun: redaction", () => {
  test("success path: the key in codex output, command output and stderr never reaches the store or the SSE bytes", async () => {
    const r = await run(fake({
      chunks: [[msg(`my key is ${KEY}`), cmd("env", `OPENROUTER_API_KEY=${KEY}`), codexExit(0), testResult(0), ...diffBlock([`+// ${KEY}`])]],
      stderrTail: [`warn ${KEY}`],
    }));
    assert.ok(!JSON.stringify(r.rec).includes(KEY));
    assert.ok(!r.sse.includes(KEY));
    assert.ok(r.sse.includes("[REDACTED]"));
    assert.ok(!r.rec.diff!.includes(KEY));
  });

  test("failure path: the key inside a launch error message is redacted in the stored stderr event and SSE", async () => {
    const r = await run(fake({ launchError: new Error(`request failed with token ${KEY}`) }));
    assert.equal(r.rec.status, "error");
    assert.ok(!JSON.stringify(r.rec).includes(KEY));
    assert.ok(!r.sse.includes(KEY));
    assert.match((r.rec.events[1] as any).text, /\[REDACTED\]/);
  });

  test("failure path: the key inside a poll error message is redacted too", async () => {
    const r = await run(fake({ pollError: new Error(`fetch failed: Bearer ${KEY}`) }));
    assert.ok(!JSON.stringify(r.rec).includes(KEY));
  });
});

const skippedResult = (reason: string) => J({ type: "test_result", exitCode: 0, skipped: reason });

describe("executeRun: skipped tests", () => {
  test("a skipped test step with a diff ends done (exit 0), and the event keeps the reason", async () => {
    const r = await run(fake({ chunks: [[msg("x"), codexExit(0)], [skippedResult("no tests found"), ...diffBlock()]] }));
    assert.equal(r.rec.status, "done");
    assert.deepEqual(r.rec.events.at(-1), { type: "done", ts: 5000, exitCode: 0 });
    const tr: any = r.rec.events.find((e) => e.type === "test_result");
    assert.equal(tr?.summary, "tests not run: no tests found");
    assert.equal(tr?.skipped, "no tests found");
  });
  test("a skipped step cannot rescue a failed agent or an empty diff", async () => {
    assert.equal((await run(fake({ chunks: [[codexExit(1)], [skippedResult("no tests found"), ...diffBlock()]] }))).rec.status, "error");
    assert.equal((await run(fake({ chunks: [[codexExit(0)], [skippedResult("no tests found"), ...diffBlock([])]] }))).rec.status, "error");
  });
  test("a real test failure still ends error with the test's exit code", async () => {
    const r = await run(fake({ chunks: [[codexExit(0)], [testResult(3), ...diffBlock()]] }));
    assert.equal(r.rec.status, "error");
    assert.deepEqual(r.rec.events.at(-1), { type: "done", ts: 5000, exitCode: 3 });
  });
});
