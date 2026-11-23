// Control-plane entry point.   AWS_PROFILE=kumpas-harness MICROVM_IMAGE_ARN=<arn> node api/main.ts
// Secrets (OPENROUTER_API_KEY, optional GIT_PUSH_TOKEN) are read from the environment or a gitignored .env, never from code.
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { createAwsMicrovms } from "./aws-microvms.ts";
import { createMicrovmLauncher } from "./microvm-launcher.ts";
import { createRedactor } from "./redact.ts";
import { executeRun } from "./run-controller.ts";
import { createRunStore } from "./run-store.ts";
import { createApp, startServer } from "./server.ts";

export function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (m && !raw.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export async function main(): Promise<void> {
  loadDotEnv(join(import.meta.dirname, "..", ".env"));
  const apiKey = process.env.OPENROUTER_API_KEY;
  const imageArn = process.env.MICROVM_IMAGE_ARN;
  const region = process.env.AWS_REGION ?? "us-east-1";
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set (env or .env)");
  if (!imageArn) throw new Error("MICROVM_IMAGE_ARN is not set");

  const store = createRunStore();
  setInterval(() => store.sweep(), 60_000).unref();
  const redact = createRedactor([apiKey, process.env.GIT_PUSH_TOKEN ?? ""]);
  const launcher = createMicrovmLauncher({ aws: createAwsMicrovms({ region }), imageArn, apiKey, region });
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const app = createApp({ store, redact, startRun: (id) => { void executeRun({ store, launcher, redact, now: Date.now, sleep }, id); } });
  // Same origin for UI and API (npm run web:build first). Registered after the API routes, so /runs/* always wins.
  app.use("/*", serveStatic({ root: relative(process.cwd(), join(import.meta.dirname, "..", "dist", "web")).replace(/\\/g, "/") }));
  const srv = await startServer(app, { port: Number(process.env.PORT) || 3000 });
  console.log(`control plane listening on http://${srv.address}:${srv.port}`);
}

if (process.argv[1] && /api[\\/]main\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
