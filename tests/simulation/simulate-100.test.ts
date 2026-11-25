// POST /simulate and GET /simulate/:id/stream: 100 runs over ONE SSE connection. Run: node --test tests/simulation/simulate-100.test.ts
// A fake scheduler stands in for real timers, so 100 runs of 15 to 50 s finish instantly.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../api/server.ts";
import { createRunStore } from "../../api/run-store.ts";
import { createRedactor } from "../../api/redact.ts";

type Frame = { event: string; data: any };
function parseSse(wire: string): Frame[] {
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

function fakeScheduler() {
  const q: { at: number; seq: number; fn: () => void; live: boolean }[] = [];
  let now = 0;
  let seq = 0;
  const next = () => q.filter((t) => t.live).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
  return {
    schedule(fn: () => void, ms: number) {
      const t = { at: now + ms, seq: seq++, fn, live: true };
      q.push(t);
      return () => { t.live = false; };
    },
    pending: () => q.filter((t) => t.live).length,
    // Run due timers in time order; `max` limits how many fire (to stop half way).
    async run(max = Infinity) {
      for (let i = 0; i < max; i++) {
        const t = next();
        if (!t) return;
        t.live = false;
        now = Math.max(now, t.at);
        t.fn();
        await new Promise((r) => setImmediate(r));
      }
    },
    advance(ms: number) { now += ms; },
  };
}

function setup() {
  const calls = { startRun: 0, deliver: 0 };
  const sched = fakeScheduler();
  let n = 0;
  const store = createRunStore({ now: () => 1000, ttlMs: 1e9, newId: () => `run-${++n}` });
  const app = createApp({
    store,
    redact: createRedactor(["sk-or-v1-SIMKEY-0123456789"]),
    startRun: () => { calls.startRun++; },
    sim: { schedule: sched.schedule, newId: () => "sim-a", seed: () => 42 },
    push: { token: "t", targetUrl: "https://github.com/o/r", deliver: async () => { calls.deliver++; throw new Error("must not be called"); } },
  });
  const post = (qs: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
    app.request(`/simulate${qs}`, { method: "POST", headers });
  const stream = (id: string, headers: Record<string, string> = {}) => app.request(`/simulate/${id}/stream`, { headers });
  return { app, store, sched, calls, post, stream };
}

/** POSTs /simulate and returns its id; asserts 202 first so a wrong status is an assertion failure, not a JSON crash. */
async function create(s: ReturnType<typeof setup>, n: number): Promise<string> {
  const res = await s.post(`?n=${n}`);
  assert.equal(res.status, 202);
  return (await res.json()).id;
}

/** Starts a simulation, opens its stream, runs every timer and returns the parsed frames. */
async function runAll(s: ReturnType<typeof setup>, n = 100): Promise<Frame[]> {
  const created = await s.post(`?n=${n}`);
  assert.equal(created.status, 202);
  const { id } = await created.json();
  const res = await s.stream(id);
  assert.equal(res.status, 200);
  const text = res.text();
  await s.sched.run();
  return parseSse(await text);
}

describe("POST /simulate", () => {
  test("?n=100 answers 202 with an id", async () => {
    const s = setup();
    const res = await s.post("?n=100");
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { id: "sim-a" });
  });

  test("a missing or invalid n answers 400 with an error string", async () => {
    const s = setup();
    for (const qs of ["", "?n=0", "?n=-3", "?n=201", "?n=1.5", "?n=abc", "?n="]) {
      const res = await s.post(qs);
      assert.equal(res.status, 400, qs);
      assert.equal(typeof (await res.json()).error, "string", qs);
    }
    assert.equal((await s.post("?n=1")).status, 202, "the boundary values are accepted");
  });

  test("only one simulation may be active: a second POST answers 409, and works again after the first finishes", async () => {
    const s = setup();
    assert.equal((await s.post("?n=3")).status, 202);
    assert.equal((await s.post("?n=3")).status, 409);
    const res = await s.stream("sim-a");
    const text = res.text();
    await s.sched.run();
    await text;
    assert.equal((await s.post("?n=3")).status, 202);
  });

  test("a simulation nobody connected to expires after 60 s, so it cannot block new ones forever", async () => {
    const s = setup();
    assert.equal((await s.post("?n=3")).status, 202);
    assert.equal((await s.post("?n=3")).status, 409);
    s.sched.advance(61_000);
    await s.sched.run();
    assert.equal((await s.post("?n=3")).status, 202);
    assert.equal((await s.stream("sim-a")).status, 200, "the new simulation reuses the injected id and can be streamed");
  });

  test("the request guard applies: foreign host 403, cross-origin 403, non-JSON content type 415", async () => {
    const s = setup();
    const cross = await s.app.request("/simulate?n=3", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" } });
    assert.equal(cross.status, 403);
    const host = await s.app.request("http://evil.example/simulate?n=3", { method: "POST", headers: { "content-type": "application/json" } });
    assert.equal(host.status, 403);
    assert.equal((await s.post("?n=3", { "content-type": "text/plain" })).status, 415);
    assert.equal((await s.post("?n=3")).status, 202, "a legitimate request still works, so the 403s above are the guard and not a broken route");
  });
});

describe("GET /simulate/:id/stream", () => {
  test("one connection carries all 100 runIds, and every runId gets at least one event", async () => {
    const s = setup();
    const res = await s.stream(await create(s, 100));
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = res.text();
    await s.sched.run();
    const frames = parseSse(await text);
    const perRun = new Map<string, number>();
    for (const f of frames) if (f.data.runId) perRun.set(f.data.runId, (perRun.get(f.data.runId) ?? 0) + 1);
    assert.equal(perRun.size, 100);
    for (const [id, count] of perRun) assert.ok(count >= 1, id);
  });

  test("every frame is tagged simulated: true, so a log or screenshot cannot pass for real runs", async () => {
    const frames = await runAll(setup());
    assert.ok(frames.length > 100 * 7);
    for (const f of frames) assert.equal(f.data.simulated, true, f.event);
  });

  test("exactly n done events, then one simulation_done as the last frame, and the stream ends", async () => {
    const frames = await runAll(setup(), 100);
    assert.equal(frames.filter((f) => f.event === "done").length, 100);
    assert.equal(frames.filter((f) => f.event === "simulation_done").length, 1);
    assert.equal(frames.at(-1)!.event, "simulation_done");
    assert.equal(frames.at(-1)!.data.n, 100);
  });

  test("the stream stays open until the simulation is over (no early close, nothing sent before its time)", async () => {
    const s = setup();
    const res = await s.stream(await create(s, 100));
    let settled = false;
    const text = res.text().then((t) => { settled = true; return t; });
    await s.sched.run(300); // part way through ~900 events
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, "connection must still be open half way");
    assert.ok(s.sched.pending() > 0);
    await s.sched.run();
    assert.ok((await text).endsWith("\n\n"));
    assert.equal(settled, true);
  });

  test("frames arrive in simulation time order", async () => {
    const frames = await runAll(setup(), 20);
    const ts = frames.filter((f) => f.event !== "simulation_done").map((f) => f.data.ts);
    assert.ok(ts.length > 20);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] >= ts[i - 1], `frame ${i}`);
  });

  test("a client abort cancels every pending timer", async () => {
    const s = setup();
    const res = await s.stream(await create(s, 100));
    assert.ok(s.sched.pending() > 0, "timers must be scheduled while connected");
    await res.body!.cancel();
    await new Promise((r) => setImmediate(r));
    assert.equal(s.sched.pending(), 0);
    assert.equal((await s.post("?n=3")).status, 202, "an aborted simulation no longer counts as active");
  });

  test("a finished or unknown simulation answers 204, which stops EventSource from reconnecting", async () => {
    const s = setup();
    assert.equal((await s.stream("nope")).status, 204);
    await runAll(s, 3);
    const again = await s.stream("sim-a");
    assert.equal(again.status, 204);
    assert.equal(await again.text(), "");
  });

  test("a cross-origin stream request is refused", async () => {
    const s = setup();
    await s.post("?n=3");
    const res = await s.stream("sim-a", { origin: "http://evil.example" });
    assert.equal(res.status, 403);
    assert.equal((await s.stream("sim-a")).status, 200, "the same request without the foreign origin is allowed");
  });
});

describe("simulations never touch the real machinery", () => {
  test("no run is stored, started or pushable, and the push seam is never called", async () => {
    const s = setup();
    const frames = await runAll(s, 10);
    assert.ok(frames.some((f) => f.event === "done"));
    const ids = [...new Set(frames.map((f) => f.data.runId).filter(Boolean))];
    assert.equal(ids.length, 10);
    for (const id of ids) {
      assert.equal(s.store.get(id), undefined, id);
      assert.equal((await s.app.request(`/runs/${id}`)).status, 404);
      assert.equal((await s.app.request(`/runs/${id}/push`, { method: "POST", headers: { "content-type": "application/json" } })).status, 404);
    }
    assert.equal(s.calls.startRun, 0);
    assert.equal(s.calls.deliver, 0);
  });
});
