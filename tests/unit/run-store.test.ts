// RunStore: in-memory Map + TTL. Run: node --test tests/unit/run-store.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRunStore } from "../../api/run-store.ts";
import type { TraceEvent } from "../../api/types.ts";

const REQ = { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "add a comment" };

function setup(ttlMs = 1000) {
  let t = 10_000;
  let n = 0;
  const store = createRunStore({ now: () => t, ttlMs, newId: () => `run-${++n}` });
  return { store, advance: (ms: number) => { t += ms; } };
}
const mk = (s: ReturnType<typeof setup>, req = REQ) => {
  const r = s.store.create(req);
  assert.ok(r.ok, "create should succeed");
  return (r as { ok: true; record: any }).record;
};

describe("RunStore", () => {
  test("create returns a pending record with id, request, empty events and createdAt from the clock", () => {
    const rec = mk(setup());
    assert.deepEqual(rec, { id: "run-1", request: REQ, status: "pending", events: [], createdAt: 10_000 });
  });

  test("get returns the stored record, and undefined for an unknown id", () => {
    const s = setup();
    const rec = mk(s);
    assert.equal(s.store.get(rec.id)?.id, "run-1");
    assert.equal(s.store.get("nope"), undefined);
  });

  test("get returns a snapshot: mutating it does not change the store", () => {
    const s = setup();
    const rec = mk(s);
    const snap = s.store.get(rec.id)!;
    snap.status = "done";
    snap.events.push({ type: "done", ts: 1, exitCode: 0 });
    assert.equal(s.store.get(rec.id)!.status, "pending");
    assert.equal(s.store.get(rec.id)!.events.length, 0);
  });

  test("a duplicate submit of the same repoUrl + task is rejected while the first run is active", () => {
    const s = setup();
    const first = mk(s);
    assert.deepEqual(s.store.create(REQ), { ok: false, reason: "duplicate", existingId: first.id });
    s.store.update(first.id, { status: "running" });
    assert.deepEqual(s.store.create({ ...REQ }), { ok: false, reason: "duplicate", existingId: first.id });
  });

  test("a different task or a different repo is not a duplicate", () => {
    const s = setup();
    mk(s);
    assert.equal(s.store.create({ ...REQ, task: "another task" }).ok, true);
    assert.equal(s.store.create({ ...REQ, repoUrl: "https://github.com/jyvnn/other" }).ok, true);
  });

  test("once a run has finished (done or error) the same request may be submitted again", () => {
    const s = setup();
    const a = mk(s);
    s.store.update(a.id, { status: "done" });
    const b = s.store.create(REQ);
    assert.equal(b.ok, true);
    s.store.update((b as any).record.id, { status: "error" });
    assert.equal(s.store.create(REQ).ok, true);
  });

  test("append adds events in order, and update merges status, diff, microvmId and the timings", () => {
    const s = setup();
    const rec = mk(s);
    s.store.append(rec.id, { type: "sandbox_resuming", ts: 1 });
    s.store.append(rec.id, { type: "sandbox_ready", ts: 2, startupMs: 3700 });
    s.store.update(rec.id, { status: "running", microvmId: "mvm-1", startupMs: 3700, firstTokenMs: 4100 });
    s.store.update(rec.id, { diff: "d", status: "done" });
    const got = s.store.get(rec.id)!;
    assert.deepEqual(got.events.map((e) => e.type), ["sandbox_resuming", "sandbox_ready"]);
    assert.deepEqual([got.status, got.microvmId, got.startupMs, got.firstTokenMs, got.diff], ["done", "mvm-1", 3700, 4100, "d"]);
  });

  test("append and update on an unknown id throw", () => {
    const s = setup();
    assert.throws(() => s.store.append("nope", { type: "sandbox_resuming", ts: 1 }), /unknown run/i);
    assert.throws(() => s.store.update("nope", { status: "done" }), /unknown run/i);
  });

  test("subscribe replays existing events, then delivers new ones live", () => {
    const s = setup();
    const rec = mk(s);
    s.store.append(rec.id, { type: "sandbox_resuming", ts: 1 });
    const seen: TraceEvent[] = [];
    s.store.subscribe(rec.id, (e) => seen.push(e));
    s.store.append(rec.id, { type: "stdout", ts: 2, text: "hi" });
    assert.deepEqual(seen.map((e) => e.type), ["sandbox_resuming", "stdout"]);
  });

  test("unsubscribe stops delivery, and one subscriber does not affect another", () => {
    const s = setup();
    const rec = mk(s);
    const a: string[] = [];
    const b: string[] = [];
    const offA = s.store.subscribe(rec.id, (e) => a.push(e.type));
    s.store.subscribe(rec.id, (e) => b.push(e.type));
    s.store.append(rec.id, { type: "sandbox_resuming", ts: 1 });
    offA();
    s.store.append(rec.id, { type: "stdout", ts: 2, text: "x" });
    assert.deepEqual(a, ["sandbox_resuming"]);
    assert.deepEqual(b, ["sandbox_resuming", "stdout"]);
  });

  test("a throwing subscriber does not break append or other subscribers", () => {
    const s = setup();
    const rec = mk(s);
    const ok: string[] = [];
    s.store.subscribe(rec.id, () => { throw new Error("boom"); });
    s.store.subscribe(rec.id, (e) => ok.push(e.type));
    assert.doesNotThrow(() => s.store.append(rec.id, { type: "sandbox_resuming", ts: 1 }));
    assert.deepEqual(ok, ["sandbox_resuming"]);
    assert.equal(s.store.get(rec.id)!.events.length, 1);
  });

  test("a record expires exactly when the clock reaches createdAt + ttl", () => {
    const s = setup(1000);
    const rec = mk(s);
    s.advance(999);
    assert.ok(s.store.get(rec.id), "still alive 1 ms before the ttl");
    s.advance(1);
    assert.equal(s.store.get(rec.id), undefined);
  });

  test("sweep removes expired records, returns how many, and keeps live ones", () => {
    const s = setup(1000);
    const old1 = mk(s);
    const old2 = mk(s, { ...REQ, task: "t2" });
    s.advance(600);
    const fresh = mk(s, { ...REQ, task: "t3" });
    s.advance(500);
    assert.equal(s.store.sweep(), 2);
    assert.equal(s.store.get(old1.id), undefined);
    assert.equal(s.store.get(old2.id), undefined);
    assert.ok(s.store.get(fresh.id));
    assert.equal(s.store.sweep(), 0);
  });

  test("an expired active run no longer blocks resubmitting the same request", () => {
    const s = setup(1000);
    mk(s);
    s.advance(1000);
    assert.equal(s.store.create(REQ).ok, true);
  });
});
