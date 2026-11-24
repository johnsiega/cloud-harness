// @integration: ONE real Lambda MicroVM through the real control plane (HTTP -> SSE). Costs a few cents; skipped by default.
//   RUN_INTEGRATION=1 AWS_PROFILE=<your-profile> MICROVM_IMAGE_ARN=<arn> node --test tests/integration/end-to-end.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAwsMicrovms } from "../../api/aws-microvms.ts";
import { loadDotEnv } from "../../api/main.ts";
import { createMicrovmLauncher } from "../../api/microvm-launcher.ts";
import { createRedactor } from "../../api/redact.ts";
import { executeRun } from "../../api/run-controller.ts";
import { createRunStore } from "../../api/run-store.ts";
import { createApp, startServer } from "../../api/server.ts";
import { join } from "node:path";

const enabled = process.env.RUN_INTEGRATION === "1" && !!process.env.MICROVM_IMAGE_ARN;

test("@integration a real run streams parsed events over SSE and returns a diff containing the requested comment", { skip: !enabled && "set RUN_INTEGRATION=1 and MICROVM_IMAGE_ARN", timeout: 10 * 60_000 }, async () => {
  loadDotEnv(join(import.meta.dirname, "..", "..", ".env"));
  const apiKey = process.env.OPENROUTER_API_KEY!;
  const region = process.env.AWS_REGION ?? "us-east-1";
  const store = createRunStore();
  const redact = createRedactor([apiKey]);
  const launcher = createMicrovmLauncher({ aws: createAwsMicrovms({ region }), imageArn: process.env.MICROVM_IMAGE_ARN!, apiKey, region });
  const app = createApp({ store, redact, startRun: (id) => { void executeRun({ store, launcher, redact, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }, id); } });
  const srv = await startServer(app, { port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    const res = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/jyvnn/hospital-queue", task: "Add the one-line HTML comment <!-- harness-check --> as the very first line of README.md. Change nothing else." }),
    });
    assert.equal(res.status, 202);
    const { id } = (await res.json()) as { id: string };

    const stream = await fetch(`${base}/runs/${id}/stream`);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    const wire = await stream.text(); // the stream ends after `done`
    const types = [...wire.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);

    assert.equal(types[0], "sandbox_resuming");
    assert.equal(types[1], "sandbox_ready");
    assert.equal(types.at(-1), "done");
    for (const t of ["reasoning", "stdout", "test_result", "diff"]) assert.ok(types.includes(t), `missing ${t} in ${types.join(",")}`);
    assert.ok(!wire.includes(apiKey), "the API key must never reach the SSE bytes");

    const rec = (await (await fetch(`${base}/runs/${id}`)).json()) as any;
    console.log(JSON.stringify({ status: rec.status, startupMs: rec.startupMs, firstTokenMs: rec.firstTokenMs, events: types.length, diffBytes: rec.diff?.length }));
    assert.equal(rec.status, "done");
    assert.ok(typeof rec.startupMs === "number" && rec.startupMs > 0);
    assert.ok(rec.diff.includes("README.md") && rec.diff.includes("harness-check"), "diff must contain the requested comment");
  } finally {
    await srv.close();
  }
});
