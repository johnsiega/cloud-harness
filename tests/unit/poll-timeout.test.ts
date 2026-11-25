// Per-request timeout on every call to the in-VM runner. Run: node --test tests/unit/poll-timeout.test.ts
// Without it, a MicroVM killed mid-run leaves fetch() hanging and the run stuck "running" until the 20-minute poll budget ends.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createMicrovmLauncher } from "../../api/microvm-launcher.ts";
import { executeRun } from "../../api/run-controller.ts";
import { createRunStore } from "../../api/run-store.ts";
import { createRedactor } from "../../api/redact.ts";
import type { FetchLike } from "../../api/types.ts";

const KEY = "sk-or-v1-TIMEOUTKEY-0123456789";
const REQ = { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "add a comment above enabled()" };
const TIMEOUT_MS = 30;
const GUARD_MS = 3000; // if the code under test still hangs, fail with an assertion instead of hanging the whole suite

// The timer stays ref'd on purpose: if it were unref'd, node:test would cancel the test as "event loop empty" instead of failing it.
// Fails (as an assertion) when p has not settled within ms, then stops its own timer.
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new assert.AssertionError({ message: `still pending after ${ms} ms: the call hangs instead of timing out` })), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

// A fetch whose events/health/start answer can be made to hang until the request's AbortSignal fires.
function setup(hang: { health?: boolean; start?: boolean; events?: boolean | ((n: number) => boolean) }) {
  const seen: { url: string; signal?: AbortSignal }[] = [];
  let eventsN = 0;
  const hangs = (url: string) => {
    if (url.endsWith("/health")) return hang.health === true;
    if (url.includes("/events")) return typeof hang.events === "function" ? hang.events(eventsN++) : hang.events === true;
    return hang.start === true;
  };
  const fetch: FetchLike = (url, init) => {
    seen.push({ url, signal: init?.signal });
    if (hangs(url)) {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason ?? new Error("aborted")), { once: true });
        // no signal given: never settles, exactly like a dead connection
      });
    }
    if (url.includes("/events")) {
      const body = { lines: [], next: 0, done: false, exitCode: null, stderrTail: [] };
      return Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => "" });
    }
    return Promise.resolve({ ok: true, status: url.endsWith("/health") ? 200 : 202, json: async () => ({}), text: async () => "" });
  };
  const terminated: string[] = [];
  const aws = {
    run: async () => ({ microvmId: "mvm-1", endpoint: "e.on.aws" }),
    authToken: async () => "tok",
    terminate: async (id: string) => { terminated.push(id); },
  };
  let t = 0;
  const launcher = createMicrovmLauncher({
    aws, imageArn: "arn:aws:lambda:us-east-1:111122223333:microvm-image:x", apiKey: KEY, fetch,
    now: () => t, sleep: async (ms) => { t += ms; }, readyTimeoutMs: 1000, readyPollMs: 250, requestTimeoutMs: TIMEOUT_MS,
  });
  return { launcher, seen, terminated };
}

const HANDLE = { microvmId: "mvm-1", endpoint: "e.on.aws", authToken: "tok", submitMs: 0, readyMs: 1 };

describe("runner calls carry a timeout signal", () => {
  test("health probe, start and poll each pass an AbortSignal to fetch", async () => {
    const s = setup({});
    const h = await s.launcher.launch(REQ);
    await s.launcher.start(h, REQ);
    await s.launcher.poll(h, 0);
    assert.ok(s.seen.length >= 3, "health, start and poll must all have gone through fetch");
    for (const c of s.seen) assert.ok(c.signal instanceof AbortSignal, `no signal on ${c.url}`);
  });

  test("a signal is not already aborted when the request starts", async () => {
    const s = setup({});
    await s.launcher.poll(HANDLE, 0);
    assert.equal(s.seen.length, 1);
    assert.equal(s.seen[0].signal?.aborted, false);
  });
});

describe("a hanging poll", () => {
  test("rejects with a timeout error naming the limit, instead of hanging", async () => {
    const s = setup({ events: true });
    await assert.rejects(within(s.launcher.poll(HANDLE, 0), GUARD_MS), (e: Error) => {
      assert.match(e.message, /timed out/i);
      assert.ok(e.message.includes(String(TIMEOUT_MS)), `message should name the ${TIMEOUT_MS} ms limit: ${e.message}`);
      return true;
    });
  });

  test("a healthy poll is unaffected", async () => {
    const s = setup({});
    const r = await within(s.launcher.poll(HANDLE, 0), GUARD_MS);
    assert.deepEqual(r, { lines: [], next: 0, done: false, exitCode: null, stderrTail: [] });
  });
});

describe("a hanging start and a hanging readiness probe", () => {
  test("start rejects with a timeout error", async () => {
    const s = setup({ start: true });
    await assert.rejects(within(s.launcher.start(HANDLE, REQ), GUARD_MS), /timed out/i);
  });

  test("a hanging health probe is retried like a network error, and launch ends 'not ready' with the MicroVM terminated", async () => {
    const s = setup({ health: true });
    await assert.rejects(within(s.launcher.launch(REQ), GUARD_MS), /not ready/i);
    assert.deepEqual(s.terminated, ["mvm-1"]);
    assert.ok(s.seen.filter((c) => c.url.endsWith("/health")).length >= 2, "must have retried");
  });
});

describe("run controller with the real launcher", () => {
  test("a poll that hangs after a good one becomes a run error and the MicroVM is still terminated", async () => {
    const s = setup({ events: (n) => n >= 1 });
    const store = createRunStore({ now: () => 1000, ttlMs: 1e9, newId: () => "run-1" });
    const created = store.create(REQ);
    assert.ok(created.ok);
    await within(
      executeRun({ store, launcher: s.launcher, redact: createRedactor([KEY]), now: () => 1000, sleep: async () => {} }, "run-1"),
      GUARD_MS,
    );
    const run = store.get("run-1")!;
    assert.equal(run.status, "error");
    assert.ok(run.events.some((e) => e.type === "stderr" && /timed out/i.test(e.text)), "the timeout must be reported on the run");
    assert.deepEqual(run.events.at(-1), { type: "done", ts: 1000, exitCode: 1 });
    assert.deepEqual(s.terminated, ["mvm-1"]);
  });
});
