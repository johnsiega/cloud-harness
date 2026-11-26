// MicroVMLauncher with a mocked AWS layer and a mocked fetch. Run: node --test tests/unit/microvm-launcher.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createMicrovmLauncher } from "../../api/microvm-launcher.ts";
import type { FetchLike } from "../../api/types.ts";
import type { RunKeys } from "../../api/openrouter-keys.ts";

const KEY = "sk-or-v1-LAUNCHERKEY-0123456789";
const IMAGE = "arn:aws:lambda:us-east-1:111122223333:microvm-image:hq-smoke";
const ENDPOINT = "mvm-1.lambda-microvm.us-east-1.on.aws";
const REQ = { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "add a comment above enabled()" };
type Call = { url: string; init: any };

function setup(o: { health?: (n: number) => "ok" | "503" | "throw"; startStatus?: number; pollOk?: boolean; runError?: Error; terminateError?: Error; runKeys?: RunKeys; warn?: (s: string) => void; order?: string[] } = {}) {
  let t = 1000;
  const awsCalls = { run: [] as any[], token: [] as string[], terminate: [] as string[] };
  const aws = {
    run: async (input: any) => { awsCalls.run.push(input); if (o.runError) throw o.runError; return { microvmId: "mvm-1", endpoint: ENDPOINT }; },
    authToken: async (id: string) => { awsCalls.token.push(id); return "tok-1"; },
    terminate: async (id: string) => { awsCalls.terminate.push(id); o.order?.push("aws.terminate"); if (o.terminateError) throw o.terminateError; },
  };
  const calls: Call[] = [];
  let healthN = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/health")) {
      const mode = (o.health ?? (() => "ok"))(healthN++);
      if (mode === "throw") throw new Error("ECONNRESET");
      return { ok: mode === "ok", status: mode === "ok" ? 200 : 503, json: async () => ({}), text: async () => "" };
    }
    if (init?.method === "POST") {
      const status = o.startStatus ?? 202;
      return { ok: status < 300, status, json: async () => ({}), text: async () => "runner said no" };
    }
    return { ok: o.pollOk ?? true, status: o.pollOk === false ? 500 : 200, json: async () => ({ lines: ["a"], next: 1, done: false, exitCode: null, stderrTail: [] }), text: async () => "" };
  };
  const launcher = createMicrovmLauncher({
    aws, imageArn: IMAGE, apiKey: KEY, fetch,
    now: () => t, sleep: async (ms) => { t += ms; },
    readyTimeoutMs: 2000, readyPollMs: 250,
    ...(o.runKeys ? { runKeys: o.runKeys } : {}), ...(o.warn ? { warn: o.warn } : {}),
  });
  return { launcher, awsCalls, calls };
}

// ---- per-run OpenRouter key ----
const RUN_KEY = "sk-or-v1-PERRUNKEY-abcdef0123456789";
const WARN = "warning: could not delete the per-run OpenRouter key; it expires on its own";

function fakeKeys(o: { createError?: Error; deleteError?: Error; order?: string[] } = {}) {
  const calls = { create: [] as string[], delete: [] as string[] };
  const runKeys: RunKeys = {
    create: async (label) => { calls.create.push(label); o.order?.push("create"); if (o.createError) throw o.createError; return { key: RUN_KEY, hash: "h1" }; },
    delete: async (hash) => { calls.delete.push(hash); o.order?.push("delete"); if (o.deleteError) throw o.deleteError; },
  };
  return { runKeys, calls };
}

describe("MicroVMLauncher.launch", () => {
  test("runs the image with a runHookPayload holding REPO_URL, TASK, OPENROUTER_API_KEY and the default model", async () => {
    const s = setup();
    await s.launcher.launch(REQ);
    assert.equal(s.awsCalls.run.length, 1);
    assert.equal(s.awsCalls.run[0].imageIdentifier, IMAGE);
    assert.deepEqual(JSON.parse(s.awsCalls.run[0].runHookPayload), {
      REPO_URL: REQ.repoUrl, TASK: REQ.task, OPENROUTER_API_KEY: KEY, MODEL: "deepseek/deepseek-v4.1-flash",
    });
  });

  test("a model on the request overrides the default", async () => {
    const s = setup();
    await s.launcher.launch({ ...REQ, model: "qwen/qwen3-coder" });
    assert.equal(s.awsCalls.run.length, 1, "aws.run must be called");
    assert.equal(JSON.parse(s.awsCalls.run[0].runHookPayload).MODEL, "qwen/qwen3-coder");
  });

  test("no environmentVariables are sent, and ingress plus egress connectors are attached", async () => {
    const s = setup();
    await s.launcher.launch(REQ);
    assert.equal(s.awsCalls.run.length, 1, "aws.run must be called");
    const input = s.awsCalls.run[0];
    assert.ok(!("environmentVariables" in input));
    assert.equal(input.ingressNetworkConnectors.length, 1);
    assert.equal(input.egressNetworkConnectors.length, 1);
  });

  test("an invalid repo URL is rejected before any AWS call", async () => {
    const s = setup();
    await assert.rejects(s.launcher.launch({ ...REQ, repoUrl: "https://evil.com/a/b" }), /repo/i);
    assert.equal(s.awsCalls.run.length, 0);
  });

  test("returns the handle: id, endpoint, auth token, and submit/ready timestamps from the clock", async () => {
    const s = setup({ health: (n) => (n < 2 ? "503" : "ok") }); // two failed probes => two 250 ms sleeps
    const h = await s.launcher.launch(REQ);
    assert.deepEqual(h, { microvmId: "mvm-1", endpoint: ENDPOINT, authToken: "tok-1", submitMs: 1000, readyMs: 1500 });
    assert.deepEqual(s.awsCalls.token, ["mvm-1"]);
  });

  test("probes https://<endpoint>/health with the proxy auth token and port header", async () => {
    const s = setup();
    await s.launcher.launch(REQ);
    const probe = s.calls.find((c) => c.url.endsWith("/health"))!;
    assert.ok(probe, "a /health probe must be made");
    assert.equal(probe.url, `https://${ENDPOINT}/health`);
    assert.equal(probe.init.headers["X-aws-proxy-auth"], "tok-1");
    assert.equal(probe.init.headers["X-aws-proxy-port"], "8080");
  });

  test("network errors during readiness are retried, not fatal", async () => {
    const s = setup({ health: (n) => (n === 0 ? "throw" : "ok") });
    const h = await s.launcher.launch(REQ);
    assert.equal(h.readyMs, 1250);
  });

  test("never ready: rejects with 'not ready' and terminates the half-started MicroVM", async () => {
    const s = setup({ health: () => "503" });
    await assert.rejects(s.launcher.launch(REQ), /not ready/i);
    assert.deepEqual(s.awsCalls.terminate, ["mvm-1"]);
  });

  test("an AWS run failure propagates and nothing is terminated (no MicroVM exists)", async () => {
    const s = setup({ runError: new Error("AccessDenied") });
    await assert.rejects(s.launcher.launch(REQ), /AccessDenied/);
    assert.deepEqual(s.awsCalls.terminate, []);
  });
});

describe("MicroVMLauncher.start / poll / terminate", () => {
  const handle = { microvmId: "mvm-1", endpoint: ENDPOINT, authToken: "tok-1", submitMs: 1000, readyMs: 1200 };

  test("start POSTs { repoUrl, task } as JSON to the runner on port 8080 with the auth token", async () => {
    const s = setup();
    await s.launcher.start(handle, REQ);
    const post = s.calls.find((c) => c.init?.method === "POST")!;
    assert.ok(post, "a POST must be made");
    assert.equal(post.url, `https://${ENDPOINT}/`);
    assert.equal(post.init.headers["X-aws-proxy-auth"], "tok-1");
    assert.equal(post.init.headers["X-aws-proxy-port"], "8080");
    assert.deepEqual(JSON.parse(post.init.body), { repoUrl: REQ.repoUrl, task: REQ.task });
  });

  test("start forwards the run's testCommand to the runner (and still never the API key)", async () => {
    const s = setup();
    await s.launcher.start(handle, { ...REQ, testCommand: "skip" });
    const post = s.calls.find((c) => c.init?.method === "POST")!;
    assert.ok(post, "a POST must be made");
    assert.deepEqual(JSON.parse(post.init.body), { repoUrl: REQ.repoUrl, task: REQ.task, testCommand: "skip" });
    assert.ok(!JSON.stringify(post).includes(KEY));
  });

  test("start rejects with the HTTP status when the runner does not answer 202", async () => {
    const s = setup({ startStatus: 412 });
    await assert.rejects(s.launcher.start(handle, REQ), /412/);
  });

  test("poll GETs /events?since=N and returns the runner's JSON", async () => {
    const s = setup();
    const r = await s.launcher.poll(handle, 7);
    assert.ok(s.calls.length > 0, "a GET must be made");
    const get = s.calls.at(-1)!;
    assert.equal(get.url, `https://${ENDPOINT}/events?since=7`);
    assert.equal(get.init.headers["X-aws-proxy-auth"], "tok-1");
    assert.deepEqual(r, { lines: ["a"], next: 1, done: false, exitCode: null, stderrTail: [] });
  });

  test("poll rejects when the runner answers with an error status", async () => {
    const s = setup({ pollOk: false });
    await assert.rejects(s.launcher.poll(handle, 0), /500/);
  });

  test("terminate calls AWS terminate for the MicroVM id", async () => {
    const s = setup();
    await s.launcher.terminate(handle);
    assert.deepEqual(s.awsCalls.terminate, ["mvm-1"]);
  });

  test("terminate never throws, so cleanup cannot mask the real error", async () => {
    const s = setup({ terminateError: new Error("already gone") });
    await assert.doesNotReject(s.launcher.terminate(handle));
  });
});

describe("secret handling", () => {
  test("the API key appears only inside the run hook payload: never in any fetch URL, header or body", async () => {
    const s = setup();
    const h = await s.launcher.launch(REQ);
    await s.launcher.start(h, REQ);
    await s.launcher.poll(h, 0);
    assert.equal(s.awsCalls.run.length, 1, "aws.run must be called");
    assert.ok(s.calls.length >= 3, "health probe, start and poll must all be made");
    assert.ok(!JSON.stringify(s.calls).includes(KEY));
    const { runHookPayload, ...rest } = s.awsCalls.run[0];
    assert.ok(runHookPayload.includes(KEY));
    assert.ok(!JSON.stringify(rest).includes(KEY));
  });
});

describe("per-run OpenRouter key", () => {
  test("the payload carries the per-run key and never the long-lived key", async () => {
    const k = fakeKeys();
    const s = setup({ runKeys: k.runKeys });
    await s.launcher.launch(REQ, "r1");
    assert.equal(s.awsCalls.run.length, 1, "aws.run must be called");
    assert.equal(JSON.parse(s.awsCalls.run[0].runHookPayload).OPENROUTER_API_KEY, RUN_KEY);
    assert.ok(!JSON.stringify(s.awsCalls.run[0]).includes(KEY), "the long-lived key must not reach AWS");
    assert.ok(!JSON.stringify(s.calls).includes(RUN_KEY), "the per-run key never appears in a runner call");
  });

  test("the key is named throwbox-run-<runId>, or throwbox-run-<now> without a run id", async () => {
    const a = fakeKeys();
    await setup({ runKeys: a.runKeys }).launcher.launch(REQ, "r1");
    assert.deepEqual(a.calls.create, ["throwbox-run-r1"]);
    const b = fakeKeys();
    await setup({ runKeys: b.runKeys }).launcher.launch(REQ);
    assert.deepEqual(b.calls.create, ["throwbox-run-1000"]);
  });

  test("an invalid repo URL or model creates no key and starts no VM", async () => {
    for (const req of [{ ...REQ, repoUrl: "https://evil.com/a/b" }, { ...REQ, model: "not a model" }]) {
      const k = fakeKeys();
      const s = setup({ runKeys: k.runKeys });
      await assert.rejects(s.launcher.launch(req, "r1"));
      assert.deepEqual(k.calls.create, [], "no key for an invalid request");
      assert.equal(s.awsCalls.run.length, 0);
    }
  });

  test("a failed create starts no VM and never falls back to the long-lived key", async () => {
    const k = fakeKeys({ createError: new Error("could not create a per-run OpenRouter key (HTTP 401)") });
    const s = setup({ runKeys: k.runKeys });
    await assert.rejects(s.launcher.launch(REQ, "r1"), /could not create a per-run OpenRouter key \(HTTP 401\)/);
    assert.equal(k.calls.create.length, 1, "create must be tried");
    assert.equal(s.awsCalls.run.length, 0, "no VM without a per-run key");
  });

  test("aws.run throwing (a quota refusal, say) still deletes the key and rethrows the AWS error", async () => {
    const k = fakeKeys();
    const s = setup({ runKeys: k.runKeys, runError: new Error("The base maximum allocated memory limit has been reached for this account.") });
    await assert.rejects(s.launcher.launch(REQ, "r1"), /memory limit/);
    assert.deepEqual(k.calls.delete, ["h1"]);
    assert.deepEqual(s.awsCalls.terminate, [], "no MicroVM exists");
  });

  test("a VM that never becomes ready is terminated and its key deleted, once each", async () => {
    const k = fakeKeys();
    const s = setup({ runKeys: k.runKeys, health: () => "503" });
    await assert.rejects(s.launcher.launch(REQ, "r1"), /not ready/i);
    assert.deepEqual(s.awsCalls.terminate, ["mvm-1"]);
    assert.deepEqual(k.calls.delete, ["h1"]);
  });

  test("the handle carries the key hash, and terminate deletes the key after terminating the VM", async () => {
    const order: string[] = [];
    const k = fakeKeys({ order });
    const s = setup({ runKeys: k.runKeys, order });
    const h = await s.launcher.launch(REQ, "r1");
    assert.equal(h.keyHash, "h1");
    await s.launcher.terminate(h);
    assert.deepEqual(order, ["create", "aws.terminate", "delete"]);
  });

  test("a failed delete does not reject terminate and logs one fixed warning with no key or hash", async () => {
    const warnings: string[] = [];
    const k = fakeKeys({ deleteError: new Error(`HTTP 500 ${RUN_KEY}`) });
    const s = setup({ runKeys: k.runKeys, warn: (m) => warnings.push(m) });
    const h = await s.launcher.launch(REQ, "r1");
    await assert.doesNotReject(s.launcher.terminate(h));
    assert.equal(k.calls.delete.length, 1, "delete must be tried");
    assert.deepEqual(warnings, [WARN]);
  });

  test("terminate deletes nothing for a handle without a key hash", async () => {
    const k = fakeKeys();
    const s = setup({ runKeys: k.runKeys });
    await s.launcher.terminate({ microvmId: "mvm-1", endpoint: ENDPOINT, authToken: "tok-1", submitMs: 1, readyMs: 2 });
    assert.deepEqual(s.awsCalls.terminate, ["mvm-1"], "the VM is still terminated");
    assert.deepEqual(k.calls.delete, []);
  });

  test("feature off: the handle has no keyHash field and the long-lived key is in the payload", async () => {
    const s = setup();
    const h = await s.launcher.launch(REQ, "r1");
    assert.ok(!("keyHash" in h));
    assert.equal(JSON.parse(s.awsCalls.run[0].runHookPayload).OPENROUTER_API_KEY, KEY);
  });
});
