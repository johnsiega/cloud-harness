// HTTP routes (Hono) and loopback binding. Run: node --test tests/unit/server.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createApp, startServer } from "../../api/server.ts";
import { createRunStore } from "../../api/run-store.ts";
import { createRedactor } from "../../api/redact.ts";
import { formatSse } from "../../api/sse.ts";
import type { TraceEvent } from "../../api/types.ts";

const KEY = "sk-or-v1-SERVERKEY-0123456789";
const GOOD = { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "add a comment above enabled()" };

function setup(startRun?: (id: string) => void) {
  let n = 0;
  const store = createRunStore({ now: () => 1000, ttlMs: 1e9, newId: () => `run-${++n}` });
  const started: string[] = [];
  const app = createApp({ store, redact: createRedactor([KEY]), startRun: startRun ?? ((id) => { started.push(id); }) });
  const post = (body: unknown) =>
    app.request("/runs", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { app, store, started, post };
}

describe("POST /runs", () => {
  test("a valid request answers 202 with an id, stores a pending record and starts the run once", async () => {
    const s = setup();
    const res = await s.post(GOOD);
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { id: "run-1" });
    assert.deepEqual(s.started, ["run-1"]);
    assert.ok(s.store.get("run-1"), "record must be stored");
    assert.equal(s.store.get("run-1")!.status, "pending");
    assert.deepEqual(s.store.get("run-1")!.request, GOOD);
  });

  test("an optional model is kept on the stored request", async () => {
    const s = setup();
    await s.post({ ...GOOD, model: "qwen/qwen3-coder" });
    assert.ok(s.store.get("run-1"), "record must be stored");
    assert.equal(s.store.get("run-1")!.request.model, "qwen/qwen3-coder");
  });

  test("an optional testCommand is trimmed and kept on the stored request", async () => {
    const s = setup();
    assert.equal((await s.post({ ...GOOD, testCommand: "  npm run check  " })).status, 202);
    assert.equal(s.store.get("run-1")?.request.testCommand, "npm run check");
  });

  test("'skip' in any letter case is stored as skip", async () => {
    const s = setup();
    await s.post({ ...GOOD, testCommand: " SKIP " });
    assert.equal(s.store.get("run-1")?.request.testCommand, "skip");
  });

  test("a blank testCommand means auto-detect: no testCommand key is stored", async () => {
    const s = setup();
    await s.post({ ...GOOD, testCommand: "   " });
    assert.ok(s.store.get("run-1"), "record must be stored");
    assert.deepEqual(s.store.get("run-1")!.request, GOOD);
  });

  test("exactly 500 characters is accepted", async () => {
    assert.equal((await setup().post({ ...GOOD, testCommand: "x".repeat(500) })).status, 202);
  });

  test("invalid submissions answer 400 with an error string, and nothing is stored or started", async () => {
    const s = setup();
    const bad: unknown[] = [
      "{not json",
      "[]",
      '"a string"',
      {},
      { repoUrl: GOOD.repoUrl },
      { task: GOOD.task },
      { repoUrl: 42, task: GOOD.task },
      { repoUrl: GOOD.repoUrl, task: 42 },
      { ...GOOD, task: "   " },
      { ...GOOD, repoUrl: "http://github.com/jyvnn/hospital-queue" },
      { ...GOOD, repoUrl: "https://evil.com/jyvnn/hospital-queue" },
      { ...GOOD, repoUrl: "https://github.com@evil.com/jyvnn/hospital-queue" },
      { ...GOOD, repoUrl: "file:///etc/passwd" },
      { ...GOOD, task: "x".repeat(20000) },
      { ...GOOD, model: "bad model" },
      { ...GOOD, model: 7 },
      { ...GOOD, testCommand: 42 },
      { ...GOOD, testCommand: null },
      { ...GOOD, testCommand: ["npm test"] },
      { ...GOOD, testCommand: "x".repeat(501) },
    ];
    for (const b of bad) {
      const res = await s.post(b);
      assert.equal(res.status, 400, JSON.stringify(b).slice(0, 80));
      assert.equal(typeof (await res.json()).error, "string");
    }
    assert.deepEqual(s.started, []);
    assert.equal(s.store.get("run-1"), undefined);
  });

  test("a duplicate of an active run answers 409 with the existing id and does not start another run", async () => {
    const s = setup();
    await s.post(GOOD);
    const res = await s.post(GOOD);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "duplicate run in progress", existingId: "run-1" });
    assert.deepEqual(s.started, ["run-1"]);
  });

  test("a startRun that throws does not turn the request into a 500", async () => {
    const s = setup(() => { throw new Error("launcher exploded"); });
    assert.equal((await s.post(GOOD)).status, 202);
  });
});

describe("GET /runs/:id", () => {
  test("returns the record as JSON, 404 for an unknown id", async () => {
    const s = setup();
    await s.post(GOOD);
    s.store.append("run-1", { type: "sandbox_resuming", ts: 1 });
    const res = await s.app.request("/runs/run-1");
    assert.equal(res.status, 200);
    const rec = await res.json();
    assert.deepEqual([rec.id, rec.status, rec.events.length], ["run-1", "pending", 1]);
    assert.equal((await s.app.request("/runs/nope")).status, 404);
  });

  test("a secret that slipped into the store is still redacted on the way out", async () => {
    const s = setup();
    await s.post(GOOD);
    s.store.append("run-1", { type: "stdout", ts: 1, text: `leaked ${KEY}` });
    s.store.update("run-1", { diff: `+${KEY}` });
    const body = await (await s.app.request("/runs/run-1")).text();
    assert.ok(!body.includes(KEY));
    assert.ok(body.includes("[REDACTED]"));
  });
});

describe("GET /runs/:id/stream", () => {
  const evs: TraceEvent[] = [
    { type: "sandbox_resuming", ts: 1 },
    { type: "sandbox_ready", ts: 2, startupMs: 3700 },
    { type: "diff", ts: 3, diff: "diff --git a/f b/f\n+x\n" },
    { type: "done", ts: 4, exitCode: 0 },
  ];

  test("a finished run replays every event as SSE frames, tagged with runId, then the stream ends", async () => {
    const s = setup();
    await s.post(GOOD);
    for (const e of evs) s.store.append("run-1", e);
    s.store.update("run-1", { status: "done" });
    const res = await s.app.request("/runs/run-1/stream");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(await res.text(), evs.map((e) => formatSse(e, "run-1")).join(""));
  });

  test("a running run streams events appended after the connection opened, and ends after done", async () => {
    const s = setup();
    await s.post(GOOD);
    s.store.update("run-1", { status: "running" });
    const res = await s.app.request("/runs/run-1/stream");
    s.store.append("run-1", evs[0]);
    s.store.append("run-1", evs[1]);
    s.store.append("run-1", evs[3]);
    assert.equal(await res.text(), [evs[0], evs[1], evs[3]].map((e) => formatSse(e, "run-1")).join(""));
  });

  test("an unknown run answers 404 and is not an event stream", async () => {
    const s = setup();
    const res = await s.app.request("/runs/nope/stream");
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.headers.get("content-type") ?? "", /event-stream/);
  });

  test("a secret that slipped into the store never reaches the stream bytes", async () => {
    const s = setup();
    await s.post(GOOD);
    s.store.append("run-1", { type: "stdout", ts: 1, text: `oops ${KEY}` });
    s.store.append("run-1", { type: "done", ts: 2, exitCode: 1 });
    const text = await (await s.app.request("/runs/run-1/stream")).text();
    assert.ok(!text.includes(KEY));
    assert.ok(text.includes("[REDACTED]"));
  });
});

describe("startServer", () => {
  test("binds to 127.0.0.1 only and serves GET /health", async () => {
    const s = setup();
    const srv = await startServer(s.app, { port: 0 });
    try {
      assert.equal(srv.address, "127.0.0.1");
      assert.ok(srv.port > 0);
      const res = await fetch(`http://127.0.0.1:${srv.port}/health`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    } finally {
      await srv.close();
    }
  });
});
