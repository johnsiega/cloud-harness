// @integration: five real MicroVMs through the real control plane, proving the Node, Python, typed, skip and failing test paths
// against two tiny public fixture repos. Costs a few cents; skipped by default.
//   RUN_INTEGRATION=1 AWS_PROFILE=<your-profile> MICROVM_IMAGE_ARN=<arn> node --test tests/integration/test-paths.test.ts
// Optional: FIXTURE_NODE, FIXTURE_PYTHON (repo URLs), TEST_PATHS_OUT (JSON file for the measurements).
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAwsMicrovms } from "../../api/aws-microvms.ts";
import { loadDotEnv } from "../../api/main.ts";
import { createMicrovmLauncher } from "../../api/microvm-launcher.ts";
import { createRunKeys, parseRunKeyLimit } from "../../api/openrouter-keys.ts";
import { createRedactor } from "../../api/redact.ts";
import { executeRun } from "../../api/run-controller.ts";
import { createRunStore } from "../../api/run-store.ts";
import { createApp, startServer } from "../../api/server.ts";

const enabled = process.env.RUN_INTEGRATION === "1" && !!process.env.MICROVM_IMAGE_ARN;
const skip = !enabled && "set RUN_INTEGRATION=1 and MICROVM_IMAGE_ARN";
const NODE = process.env.FIXTURE_NODE ?? "https://github.com/johnsiega/throwbox-fixture-node";
const PYTHON = process.env.FIXTURE_PYTHON ?? "https://github.com/johnsiega/throwbox-fixture-python";
const task = (file: string) => `Add a one-line comment directly above the add function in ${file} saying what it returns. Change nothing else.`;

let base = "";
let secrets: string[] = [];
let perRunKeys = false;
let close = async () => {};
const records: Record<string, unknown>[] = [];

async function realRun(name: string, body: { repoUrl: string; task: string; testCommand?: string }) {
  const started = Date.now();
  const res = await fetch(`${base}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(res.status, 202);
  const { id } = (await res.json()) as { id: string };
  const wire = await (await fetch(`${base}/runs/${id}/stream`)).text(); // the stream ends after `done`
  for (const s of secrets) assert.ok(!wire.includes(s), "no key may reach the SSE bytes");
  const rec = (await (await fetch(`${base}/runs/${id}`)).json()) as any;
  const tests = rec.events.find((e: any) => e.type === "test_result");
  const done = rec.events.find((e: any) => e.type === "done");
  const diff: string = rec.diff ?? "";
  const stderr = rec.events.filter((e: any) => e.type === "stderr").map((e: any) => e.text);
  records.push({ name, ...body, id, status: rec.status, tests, doneExit: done?.exitCode, diffBytes: diff.length, ms: Date.now() - started, stderr: rec.status === "done" ? [] : stderr });
  return { status: rec.status as string, tests, doneExit: done?.exitCode as number, diff };
}

const passed = (r: Awaited<ReturnType<typeof realRun>>, file: string) => {
  assert.equal(r.status, "done");
  assert.equal(r.tests?.exitCode, 0);
  assert.equal(r.tests?.skipped, undefined, "the tests must have run");
  assert.ok(r.diff.includes(file), `the diff must touch ${file}`);
};

describe("real test paths", () => {
  before(async () => {
    if (!enabled) return;
    loadDotEnv(join(import.meta.dirname, "..", "..", ".env"));
    const apiKey = process.env.OPENROUTER_API_KEY!;
    const mgmt = process.env.OPENROUTER_MANAGEMENT_KEY?.trim();
    const region = process.env.AWS_REGION ?? "us-east-1";
    perRunKeys = !!mgmt;
    secrets = [apiKey, ...(mgmt ? [mgmt] : [])];
    const store = createRunStore();
    const redact = createRedactor(secrets);
    const runKeys = mgmt ? createRunKeys({ managementKey: mgmt, limitUsd: parseRunKeyLimit(process.env.RUN_KEY_LIMIT_USD) }) : undefined;
    const launcher = createMicrovmLauncher({ aws: createAwsMicrovms({ region }), imageArn: process.env.MICROVM_IMAGE_ARN!, apiKey, region, runKeys });
    const app = createApp({ store, redact, startRun: (id) => { void executeRun({ store, launcher, redact, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }, id); } });
    const srv = await startServer(app, { port: 0 });
    base = `http://127.0.0.1:${srv.port}`;
    close = async () => { await srv.close(); };
  });

  after(async () => {
    await close();
    if (enabled && process.env.TEST_PATHS_OUT) writeFileSync(process.env.TEST_PATHS_OUT, JSON.stringify({ date: new Date().toISOString(), perRunKeys, runs: records }, null, 2) + "\n");
  });

  // Four at once is the account's MicroVM quota; the fifth runs after them.
  describe("first batch", { concurrency: 4 }, () => {
    test("@integration node fixture: auto-detects npm test", { skip, timeout: 10 * 60_000 }, async () => {
      passed(await realRun("node-auto", { repoUrl: NODE, task: task("math.js") }), "math.js");
    });

    test("@integration python fixture: auto-detects pytest", { skip, timeout: 10 * 60_000 }, async () => {
      passed(await realRun("python-auto", { repoUrl: PYTHON, task: task("calc.py") }), "calc.py");
    });

    test("@integration typed command runs as given", { skip, timeout: 10 * 60_000 }, async () => {
      // Same repo as node-auto, so the task text differs: the store rejects a duplicate active repo + task.
      passed(await realRun("node-typed", { repoUrl: NODE, task: `${task("math.js")} Keep it short.`, testCommand: "node --test math.test.js" }), "math.js");
    });

    test("@integration SKIP skips the tests", { skip, timeout: 10 * 60_000 }, async () => {
      const r = await realRun("node-skip", { repoUrl: NODE, task: `${task("math.js")} Use plain words.`, testCommand: "SKIP" });
      assert.equal(r.status, "done");
      assert.equal(r.tests?.skipped, "skipped by request");
      assert.ok(r.diff.includes("math.js"));
    });
  });

  test("@integration a failing typed command fails the run", { skip, timeout: 10 * 60_000 }, async () => {
    const r = await realRun("node-failing", { repoUrl: NODE, task: task("math.js"), testCommand: 'node -e "process.exit(3)"' });
    assert.equal(r.status, "error");
    assert.equal(r.tests?.exitCode, 3);
    assert.equal(r.doneExit, 3);
    assert.ok(r.diff.includes("math.js"), "the diff is still there");
  });
});
