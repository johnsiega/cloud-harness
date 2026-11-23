// POST /runs/:id/push and GET /config. deliver() is a fake, so no test here can push anywhere.
// Run: node --test tests/unit/push-route.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../api/server.ts";
import { createRunStore } from "../../api/run-store.ts";
import { createRedactor } from "../../api/redact.ts";
import type { PushInput, PushResult } from "../../api/patch-delivery.ts";

const TOKEN = "github_pat_11ROUTETOKEN_abcdefghijklmnopqrstuvwxyz0123456789";
const SHA = "ea724cea11c755453e8d826872470b2448c1cca1";
const COMMIT = "b".repeat(40);
const REPO = "https://github.com/jyvnn/hospital-queue";
const TARGET = "https://github.com/johnsiega/hospital-queue-harness";
const DIFF = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1,2 @@\n a\n+b\n";
const OK: PushResult = { ok: true, branch: "harness/run-1", commit: COMMIT, log: "git push (exit 0)" };
const fail = (reason: any, error = "nope", log = ""): PushResult => ({ ok: false, reason, error, log });

type Deliver = (i: PushInput) => Promise<PushResult>;

// Parses a response body as JSON, failing on an assertion (not a SyntaxError) when the route is missing and the body is plain text.
async function json(res: Response): Promise<any> {
  const t = await res.text();
  try { return JSON.parse(t); } catch { assert.fail(`expected a JSON body, got: ${t.slice(0, 60)}`); }
}

function setup(o: { deliver?: Deliver; configured?: boolean; run?: { status?: any; diff?: string | null; baseCommit?: string | null } } = {}) {
  let n = 0;
  const store = createRunStore({ now: () => 1000, ttlMs: 1e9, newId: () => `run-${++n}` });
  const calls: PushInput[] = [];
  const deliver: Deliver = o.deliver ?? (async (i) => { calls.push(i); return OK; });
  const tracked: Deliver = async (i) => { if (o.deliver) calls.push(i); return deliver(i); };
  const app = createApp({
    store,
    redact: createRedactor([TOKEN]),
    startRun: () => {},
    push: o.configured === false ? undefined : { token: TOKEN, targetUrl: TARGET, deliver: tracked },
  });
  store.create({ repoUrl: REPO, task: "add a comment" });
  const r = o.run ?? {};
  store.update("run-1", { status: r.status ?? "done" });
  if (r.diff !== null) store.update("run-1", { diff: r.diff ?? DIFF });
  if (r.baseCommit !== null) store.update("run-1", { baseCommit: r.baseCommit ?? SHA });
  const push = (id = "run-1", body: unknown = {}, headers: Record<string, string> = {}) =>
    app.request(`/runs/${id}/push`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { app, store, calls, push };
}

describe("POST /runs/:id/push: success", () => {
  test("a finished run is pushed once: 200 with the branch, the commit and a link to it", async () => {
    const s = setup();
    const res = await s.push();
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { branch: "harness/run-1", commit: COMMIT, url: `${TARGET}/tree/harness/run-1` });
  });

  test("delivery gets the run's own source repo, base commit and diff, the configured target, the token and the run id as branch name", async () => {
    const s = setup();
    await s.push();
    assert.deepEqual(s.calls, [{ sourceUrl: REPO, targetUrl: TARGET, baseCommit: SHA, diff: DIFF, runId: "run-1", token: TOKEN }]);
  });

  test("the caller cannot choose the branch, the target or force: extra body fields are ignored", async () => {
    const s = setup();
    const res = await s.push("run-1", { branch: "main", targetUrl: "https://github.com/evil/x", force: true, token: "other", baseCommit: "0".repeat(40), diff: "evil" });
    assert.equal(res.status, 200);
    assert.deepEqual(s.calls, [{ sourceUrl: REPO, targetUrl: TARGET, baseCommit: SHA, diff: DIFF, runId: "run-1", token: TOKEN }]);
  });

  test("the run record remembers the push, and GET /runs/:id shows it without the token", async () => {
    const s = setup();
    await s.push();
    assert.deepEqual(s.store.get("run-1")!.push, { branch: "harness/run-1", commit: COMMIT, url: `${TARGET}/tree/harness/run-1` });
    const body = await (await s.app.request("/runs/run-1")).text();
    assert.ok(body.includes("harness/run-1"));
    assert.ok(!body.includes(TOKEN));
  });
});

describe("POST /runs/:id/push: only once, only when finished", () => {
  test("a second push of the same run answers 409 with the existing branch and delivers nothing", async () => {
    const s = setup();
    await s.push();
    const res = await s.push();
    assert.equal(res.status, 409);
    const body = await json(res);
    assert.equal(body.branch, "harness/run-1");
    assert.equal(typeof body.error, "string");
    assert.equal(s.calls.length, 1);
  });

  test("two simultaneous pushes deliver exactly once; the other gets 409 and the first still succeeds", async () => {
    let release!: (r: PushResult) => void;
    const s = setup({ deliver: () => new Promise<PushResult>((r) => { release = r; }) });
    const first = s.push();
    await new Promise((r) => setTimeout(r, 20));
    const second = await s.push();
    assert.equal(second.status, 409);
    release(OK);
    assert.equal((await first).status, 200);
    assert.equal(s.calls.length, 1);
  });

  test("a run that is pending, running or failed is refused with 409 and nothing is delivered", async () => {
    for (const status of ["pending", "running", "error"]) {
      const s = setup({ run: { status } });
      const res = await s.push();
      assert.equal(res.status, 409, status);
      assert.equal(s.calls.length, 0, status);
    }
  });

  test("a finished run with no diff, an empty diff or no base commit is refused with 400", async () => {
    for (const run of [{ diff: null }, { diff: "" }, { diff: "  \n" }, { baseCommit: null }]) {
      const s = setup({ run });
      assert.equal((await s.push()).status, 400, JSON.stringify(run));
      assert.equal(s.calls.length, 0);
    }
  });

  test("an unknown run answers 404", async () => {
    const s = setup();
    const res = await s.push("nope");
    assert.equal(res.status, 404);
    assert.equal(typeof (await json(res)).error, "string", "a JSON error, not the framework's plain-text 404");
    assert.equal(s.calls.length, 0);
  });

  test("GET on the push path is not a route", async () => {
    const s = setup();
    assert.equal((await s.app.request("/runs/run-1/push")).status, 404);
  });
});

describe("POST /runs/:id/push: failures", () => {
  const table: [string, number][] = [
    ["invalid_input", 400], ["redacted_diff", 422], ["branch_exists", 409], ["stale_base", 409], ["patch_failed", 422], ["push_failed", 502],
  ];

  test("each delivery failure maps to its own HTTP status and carries the reason and a message", async () => {
    for (const [reason, status] of table) {
      const s = setup({ deliver: async () => fail(reason, `explain ${reason}`) });
      const res = await s.push();
      assert.equal(res.status, status, reason);
      const body = await json(res);
      assert.equal(body.reason, reason);
      assert.equal(body.error, `explain ${reason}`);
    }
  });

  test("a failed push is not recorded as pushed, so it can be retried", async () => {
    let n = 0;
    const s = setup({ deliver: async () => (++n === 1 ? fail("push_failed", "network") : OK) });
    assert.equal((await s.push()).status, 502);
    assert.equal(s.store.get("run-1")!.push, undefined);
    assert.equal((await s.push()).status, 200);
    assert.equal(n, 2);
  });

  test("a delivery that throws answers 502 and does not leave the run stuck as 'in progress'", async () => {
    let n = 0;
    const s = setup({ deliver: async () => { if (++n === 1) throw new Error("boom"); return OK; } });
    assert.equal((await s.push()).status, 502);
    assert.equal((await s.push()).status, 200);
  });

  test("the token never reaches the response, even if delivery returns it in the error, the log or a thrown message", async () => {
    for (const deliver of [
      async () => fail("push_failed", `fatal ${TOKEN}`, `log ${TOKEN}\n${TOKEN}`),
      async () => { throw new Error(`spawn failed ${TOKEN}`); },
    ] as Deliver[]) {
      const s = setup({ deliver });
      const res = await s.push();
      assert.equal(res.status, 502, "the failure must be reported, not swallowed");
      const text = await res.text();
      assert.ok(!text.includes(TOKEN), text);
      assert.ok(text.includes("[REDACTED]") || !text.includes("github_pat_"));
    }
  });

  test("a successful result's log is redacted too", async () => {
    const s = setup({ deliver: async () => ({ ...OK, log: `ok ${TOKEN}` }) });
    const res = await s.push();
    assert.equal(res.status, 200);
    assert.ok(!(await res.text()).includes(TOKEN));
  });
});

describe("POST /runs/:id/push: not configured and guarded", () => {
  test("without a token or target configured the route answers 503 and says how to enable it", async () => {
    const s = setup({ configured: false });
    const res = await s.push();
    assert.equal(res.status, 503);
    assert.match((await json(res)).error, /GIT_PUSH_TOKEN/);
  });

  test("cross-origin and wrong-content-type pushes are rejected before any delivery", async () => {
    const s = setup();
    assert.equal((await s.push("run-1", {}, { origin: "https://evil.example" })).status, 403);
    const textPlain = await s.app.request("/runs/run-1/push", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(textPlain.status, 415);
    assert.equal(s.calls.length, 0);
  });
});

describe("GET /config", () => {
  test("tells the UI whether push is available and where it goes, without secrets", async () => {
    const s = setup();
    const res = await s.app.request("/config");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { pushEnabled: true, pushTarget: "johnsiega/hospital-queue-harness" });
    assert.ok(!text.includes(TOKEN) && !text.includes("github_pat"));
  });

  test("reports push as disabled when it is not configured", async () => {
    const s = setup({ configured: false });
    assert.deepEqual(await json(await s.app.request("/config")), { pushEnabled: false });
  });
});
