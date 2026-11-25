// MicroVMLauncher with a mocked AWS layer and a mocked fetch. Run: node --test tests/unit/microvm-launcher.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createMicrovmLauncher } from "../../api/microvm-launcher.ts";
import type { FetchLike } from "../../api/types.ts";

const KEY = "sk-or-v1-LAUNCHERKEY-0123456789";
const IMAGE = "arn:aws:lambda:us-east-1:111122223333:microvm-image:hq-smoke";
const ENDPOINT = "mvm-1.lambda-microvm.us-east-1.on.aws";
const REQ = { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "add a comment above enabled()" };
type Call = { url: string; init: any };

function setup(o: { health?: (n: number) => "ok" | "503" | "throw"; startStatus?: number; pollOk?: boolean; runError?: Error; terminateError?: Error } = {}) {
  let t = 1000;
  const awsCalls = { run: [] as any[], token: [] as string[], terminate: [] as string[] };
  const aws = {
    run: async (input: any) => { awsCalls.run.push(input); if (o.runError) throw o.runError; return { microvmId: "mvm-1", endpoint: ENDPOINT }; },
    authToken: async (id: string) => { awsCalls.token.push(id); return "tok-1"; },
    terminate: async (id: string) => { awsCalls.terminate.push(id); if (o.terminateError) throw o.terminateError; },
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
  });
  return { launcher, awsCalls, calls };
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
