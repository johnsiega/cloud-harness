// Demo mode: the control plane starts with no OpenRouter key or MicroVM image. Run: node --test tests/unit/demo-mode.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveMode } from "../../api/mode.ts";
import { createApp } from "../../api/server.ts";
import { createRunStore } from "../../api/run-store.ts";
import { createRedactor } from "../../api/redact.ts";

const KEY = "sk-or-v1-DEMOKEY-0123456789";
const IMAGE = "arn:aws:lambda:us-east-1:000000000000:microvm-image/demo";
const REASON = "set OPENROUTER_API_KEY and MICROVM_IMAGE_ARN to enable real runs";
const GOOD = { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "add a comment above enabled()" };

describe("resolveMode", () => {
  test("with a key and an image it is real mode and returns both", () => {
    assert.deepEqual(resolveMode({ OPENROUTER_API_KEY: KEY, MICROVM_IMAGE_ARN: IMAGE }), { demo: false, apiKey: KEY, imageArn: IMAGE });
  });

  test("a missing key gives demo mode that names OPENROUTER_API_KEY and not the image variable", () => {
    const m = resolveMode({ MICROVM_IMAGE_ARN: IMAGE });
    assert.equal(m.demo, true);
    assert.ok(m.demo && m.reason.includes("OPENROUTER_API_KEY"));
    assert.ok(m.demo && !m.reason.includes("MICROVM_IMAGE_ARN"));
  });

  test("a missing image gives demo mode that names MICROVM_IMAGE_ARN and not the key variable", () => {
    const m = resolveMode({ OPENROUTER_API_KEY: KEY });
    assert.equal(m.demo, true);
    assert.ok(m.demo && m.reason.includes("MICROVM_IMAGE_ARN"));
    assert.ok(m.demo && !m.reason.includes("OPENROUTER_API_KEY"));
  });

  test("with neither set, both variables are named", () => {
    const m = resolveMode({});
    assert.equal(m.demo, true);
    assert.ok(m.demo && m.reason.includes("OPENROUTER_API_KEY") && m.reason.includes("MICROVM_IMAGE_ARN"));
  });

  test("blank or whitespace-only values count as missing", () => {
    for (const env of [{ OPENROUTER_API_KEY: "", MICROVM_IMAGE_ARN: IMAGE }, { OPENROUTER_API_KEY: KEY, MICROVM_IMAGE_ARN: "   " }]) {
      assert.equal(resolveMode(env).demo, true, JSON.stringify(Object.keys(env)));
    }
    assert.equal(resolveMode({ OPENROUTER_API_KEY: KEY, MICROVM_IMAGE_ARN: IMAGE }).demo, false, "control: both present is real mode");
  });

  test("HARNESS_DEMO=1 forces demo mode even when a key and an image are set", () => {
    const m = resolveMode({ OPENROUTER_API_KEY: KEY, MICROVM_IMAGE_ARN: IMAGE, HARNESS_DEMO: "1" });
    assert.equal(m.demo, true);
    assert.ok(m.demo && m.reason.includes("HARNESS_DEMO"));
    assert.equal(resolveMode({ OPENROUTER_API_KEY: KEY, MICROVM_IMAGE_ARN: IMAGE, HARNESS_DEMO: "0" }).demo, false);
  });

  test("the reason never contains a secret value", () => {
    for (const env of [{ OPENROUTER_API_KEY: KEY }, { MICROVM_IMAGE_ARN: IMAGE }, { OPENROUTER_API_KEY: KEY, MICROVM_IMAGE_ARN: IMAGE, HARNESS_DEMO: "1" }]) {
      const m = resolveMode(env);
      assert.ok(m.demo, "must be demo mode for this check to mean anything");
      assert.match(m.reason, /OPENROUTER_API_KEY|MICROVM_IMAGE_ARN|HARNESS_DEMO/, "the reason must name what to set");
      assert.ok(!m.reason.includes(KEY) && !m.reason.includes(IMAGE));
    }
  });
});

function setup() {
  const calls = { startRun: 0, deliver: 0 };
  const store = createRunStore({ now: () => 1000, ttlMs: 1e9, newId: () => "run-1" });
  const app = createApp({
    store,
    redact: createRedactor([KEY]),
    startRun: () => { calls.startRun++; },
    demo: { reason: REASON },
    sim: { schedule: () => () => {}, newId: () => "sim-a", seed: () => 1 },
  });
  const json = { "content-type": "application/json" };
  return { app, store, calls, json };
}

describe("control plane in demo mode", () => {
  test("GET /config reports demo: true and push disabled", async () => {
    const res = await setup().app.request("/config");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { demo: true, pushEnabled: false });
  });

  test("POST /runs answers 503 with the reason, and nothing is stored or started", async () => {
    const s = setup();
    const res = await s.app.request("/runs", { method: "POST", headers: s.json, body: JSON.stringify(GOOD) });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.ok(String(body.error).includes(REASON), "must say how to enable real runs");
    assert.match(String(body.error), /demo/i);
    assert.equal(s.store.get("run-1"), undefined);
    assert.equal(s.calls.startRun, 0);
  });

  test("POST /runs/:id/push answers 503 even for an unknown run", async () => {
    const s = setup();
    const res = await s.app.request("/runs/nope/push", { method: "POST", headers: s.json, body: "{}" });
    assert.equal(res.status, 503);
    assert.ok(String((await res.json()).error).includes(REASON));
  });

  test("the request guard still comes first: a cross-origin POST /runs is 403, not 503", async () => {
    const s = setup();
    const res = await s.app.request("/runs", { method: "POST", headers: { ...s.json, origin: "http://evil.example" }, body: JSON.stringify(GOOD) });
    assert.equal(res.status, 403);
  });

  test("the simulation still works: POST /simulate answers 202 and its stream opens", async () => {
    const s = setup();
    const created = await s.app.request("/simulate?n=3", { method: "POST", headers: s.json });
    assert.equal(created.status, 202);
    const stream = await s.app.request("/simulate/sim-a/stream");
    assert.equal(stream.status, 200);
    assert.equal((await s.app.request("/health")).status, 200);
  });

  test("without demo, /runs is not blocked and /config has no demo flag", async () => {
    const store = createRunStore({ now: () => 1000, ttlMs: 1e9, newId: () => "run-1" });
    const app = createApp({ store, redact: createRedactor([KEY]), startRun: () => {} });
    const run = await app.request("/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(GOOD) });
    assert.equal(run.status, 202);
    assert.deepEqual(await (await app.request("/config")).json(), { pushEnabled: false });
  });
});
