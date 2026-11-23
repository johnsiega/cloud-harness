// Integration tests for the in-VM runner server. Run: node --test scripts/runner/server.test.ts
// Starts the real server.mjs on a free localhost port with a fake runner script. No AWS, no external network.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = join(import.meta.dirname, "server.mjs");
const BASH = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const KEY = "sk-or-v1-SERVERTESTKEY-987654321";
const HOOK = "/aws/lambda-microvms/runtime/v1/";
const children: ChildProcess[] = [];
after(() => children.forEach((c) => c.kill()));

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

async function up(base: string): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return true;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function start(scriptBody: string) {
  const root = mkdtempSync(join(tmpdir(), "srv-")).replace(/\\/g, "/");
  writeFileSync(`${root}/fake-run.sh`, `#!/bin/bash\n${scriptBody}\n`);
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH ?? "", PORT: String(port), RUN_TASK_SCRIPT: `${root}/fake-run.sh`, RUNNER_BASH: BASH, SERVER_ONLY_SECRET: "leak-me-1", AWS_SECRET_ACCESS_KEY: "leak-me-2" },
    stdio: "ignore",
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  return { base, ready: await up(base) };
}

const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const sendRunHook = (base: string, payload: Record<string, string> = { OPENROUTER_API_KEY: KEY, MODEL: "deepseek/deepseek-v4.1-flash" }) =>
  post(`${base}${HOOK}run`, { microvmId: "mvm-test", runHookPayload: JSON.stringify(payload) });

async function drain(base: string) {
  let all: string[] = [];
  let last: any;
  for (let i = 0; i < 200; i++) {
    last = await (await fetch(`${base}/events?since=${all.length}`)).json();
    all = all.concat(last.lines);
    if (last.done) return { lines: all, last };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("run never finished");
}

const ECHO = [
  'echo "MODEL=$MODEL TASK=$TASK REPO=$REPO_URL"',
  'echo "KEY=$OPENROUTER_API_KEY"',
  'echo "LEAK=${SERVER_ONLY_SECRET:-none}/${AWS_SECRET_ACCESS_KEY:-none}"',
  'echo "oops $OPENROUTER_API_KEY" >&2',
  "exit 0",
].join("\n");

describe("runner server", () => {
  test("GET /health answers 200 and reports not-started before any run", async () => {
    const s = await start(ECHO);
    assert.ok(s.ready, "server must listen on $PORT");
    const r = await fetch(`${s.base}/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: "ok", started: false });
  });

  test("all lifecycle hook paths answer 200 (ready, run, suspend, resume, terminate)", async () => {
    const s = await start(ECHO);
    assert.ok(s.ready);
    for (const name of ["ready", "run", "suspend", "resume", "terminate"]) {
      const r = await post(`${s.base}${HOOK}${name}`, { microvmId: "m" });
      assert.equal(r.status, 200, name);
    }
  });

  test("POST / is refused with 412 until the run hook has delivered the API key", async () => {
    const s = await start(ECHO);
    assert.ok(s.ready);
    const r = await post(s.base + "/", { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "do it" });
    assert.equal(r.status, 412);
    assert.equal((await fetch(`${s.base}/events`)).status, 404, "no run may have started");
  });

  test("after the run hook, POST / starts the script with REPO_URL, TASK and the hook's MODEL and key", async () => {
    const s = await start(ECHO);
    assert.ok(s.ready);
    assert.equal((await sendRunHook(s.base)).status, 200);
    const r = await post(s.base + "/", { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "add a comment" });
    assert.equal(r.status, 202);
    const { lines, last } = await drain(s.base);
    assert.ok(lines.includes("MODEL=deepseek/deepseek-v4.1-flash TASK=add a comment REPO=https://github.com/jyvnn/hospital-queue"), JSON.stringify(lines));
    assert.equal(last.done, true);
    assert.equal(last.exitCode, 0);
  });

  test("the API key never appears in streamed lines or the stderr tail; it is replaced by ***", async () => {
    const s = await start(ECHO);
    assert.ok(s.ready);
    await sendRunHook(s.base);
    await post(s.base + "/", { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "t" });
    const { lines, last } = await drain(s.base);
    assert.ok(lines.includes("KEY=***"), JSON.stringify(lines));
    assert.ok(last.stderrTail.includes("oops ***"), JSON.stringify(last.stderrTail));
    assert.ok(!JSON.stringify([lines, last]).includes(KEY));
  });

  test("the script only sees what it needs: the server's own env (other secrets) is not passed down", async () => {
    const s = await start(ECHO);
    assert.ok(s.ready);
    await sendRunHook(s.base);
    await post(s.base + "/", { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "t" });
    const { lines } = await drain(s.base);
    assert.ok(lines.includes("LEAK=none/none"), JSON.stringify(lines));
  });

  test("a second POST / is refused with 409 and does not restart the run", async () => {
    const s = await start("echo once\nexit 0");
    assert.ok(s.ready);
    await sendRunHook(s.base);
    const body = { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "t" };
    assert.equal((await post(s.base + "/", body)).status, 202);
    assert.equal((await post(s.base + "/", body)).status, 409);
    const { lines } = await drain(s.base);
    assert.deepEqual(lines, ["once"]);
  });

  test("invalid submissions are rejected with 400 and nothing starts", async () => {
    const s = await start(ECHO);
    assert.ok(s.ready);
    await sendRunHook(s.base);
    const bad: unknown[] = [
      "{not json",
      { task: "t" },
      { repoUrl: "https://github.com/jyvnn/hospital-queue" },
      { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "" },
      { repoUrl: "http://github.com/a/b", task: "t" },
      { repoUrl: "https://evil.com/a/b", task: "t" },
      { repoUrl: "https://github.com@evil.com/a/b", task: "t" },
      { repoUrl: "https://github.com/a/b --upload-pack=x", task: "t" },
      { repoUrl: "file:///etc/passwd", task: "t" },
      { repoUrl: 42, task: "t" },
      { repoUrl: "https://github.com/a/b", task: 42 },
    ];
    for (const b of bad) assert.equal((await post(s.base + "/", b)).status, 400, JSON.stringify(b));
    assert.equal((await fetch(`${s.base}/events`)).status, 404, "no run may have started");
  });

  test("GET /events paginates with since and next, and reports done with the exit code", async () => {
    const s = await start('echo one\necho two\necho three\nexit 3');
    assert.ok(s.ready);
    await sendRunHook(s.base);
    await post(s.base + "/", { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "t" });
    const { lines, last } = await drain(s.base);
    assert.deepEqual(lines, ["one", "two", "three"]);
    assert.equal(last.exitCode, 3);
    const tail = await (await fetch(`${s.base}/events?since=2`)).json();
    assert.deepEqual(tail.lines, ["three"]);
    assert.equal(tail.next, 3);
    const none = await (await fetch(`${s.base}/events?since=99`)).json();
    assert.deepEqual(none.lines, []);
  });

  test("a final line without a trailing newline is not lost", async () => {
    const s = await start('printf "a\\nlast-no-newline"\nexit 0');
    assert.ok(s.ready);
    await sendRunHook(s.base);
    await post(s.base + "/", { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "t" });
    const { lines } = await drain(s.base);
    assert.deepEqual(lines, ["a", "last-no-newline"]);
  });

  test("a malformed run hook body does not crash the server, and the key stays missing (412)", async () => {
    const s = await start(ECHO);
    assert.ok(s.ready);
    assert.equal((await post(`${s.base}${HOOK}run`, "{broken")).status, 200);
    assert.equal((await post(`${s.base}${HOOK}run`, { runHookPayload: "{also broken" })).status, 200);
    const r = await post(s.base + "/", { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "t" });
    assert.equal(r.status, 412);
    assert.equal((await fetch(`${s.base}/health`)).status, 200, "server must still be alive");
  });

  test("unknown paths answer 404", async () => {
    const s = await start(ECHO);
    assert.ok(s.ready);
    assert.equal((await fetch(`${s.base}/nope`)).status, 404);
    assert.equal((await fetch(`${s.base}/`, { method: "GET" })).status, 404);
  });
});
