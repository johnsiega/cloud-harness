// Control-plane entry point.   AWS_PROFILE=<your-profile> MICROVM_IMAGE_ARN=<arn> node api/main.ts
// Secrets (OPENROUTER_API_KEY, optional GIT_PUSH_TOKEN) are read from the environment or a gitignored .env, never from code.
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { createAwsMicrovms } from "./aws-microvms.ts";
import { resolveMode } from "./mode.ts";
import { createMicrovmLauncher } from "./microvm-launcher.ts";
import { createGithubPrs } from "./github-pr.ts";
import { createPatchDelivery } from "./patch-delivery.ts";
import { parseRepoList } from "./repo-allowlist.ts";
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
  const region = process.env.AWS_REGION ?? "us-east-1";
  const mode = resolveMode(process.env);

  const store = createRunStore();
  const webRoot = relative(process.cwd(), join(import.meta.dirname, "..", "dist", "web")).replace(/\\/g, "/");
  if (mode.demo) {
    // Demo mode: no AWS client, no key, no push. Only the simulation runs.
    console.log(`DEMO MODE: ${mode.reason}`);
    const app = createApp({ store, redact: createRedactor([]), demo: { reason: mode.reason }, startRun: () => {} });
    app.use("/*", serveStatic({ root: webRoot }));
    const srv = await startServer(app, { port: Number(process.env.PORT) || 3000 });
    console.log(`control plane listening on http://${srv.address}:${srv.port}`);
    return;
  }
  const { apiKey, imageArn } = mode;
  setInterval(() => store.sweep(), 60_000).unref();
  const prToken = process.env.GIT_PR_TOKEN;
  const redact = createRedactor([apiKey, process.env.GIT_PUSH_TOKEN ?? "", prToken ?? ""]);
  const launcher = createMicrovmLauncher({ aws: createAwsMicrovms({ region }), imageArn, apiKey, region });
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  // Push is optional: without GIT_PUSH_TOKEN the route answers 503 and the UI hides the button. The token stays in this process.
  const pushToken = process.env.GIT_PUSH_TOKEN;
  const pushTarget = process.env.PUSH_TARGET_URL ?? "https://github.com/johnsiega/hospital-queue-harness";
  const push = pushToken ? { token: pushToken, targetUrl: pushTarget, deliver: createPatchDelivery({ redact }).pushBranch } : undefined;
  console.log(push ? `push enabled: harness/<runId> branches go to ${pushTarget}` : "push disabled (set GIT_PUSH_TOKEN in .env to enable)");
  // Draft PRs are optional and need both settings; the token stays in this process, like the push token.
  const prRepos = parseRepoList(process.env.PR_REPOS);
  const pr = prToken && prRepos.length ? { repos: prRepos, token: prToken, deliver: createPatchDelivery({ redact }).pushBranch, github: createGithubPrs({ token: prToken }) } : undefined;
  console.log(pr ? `draft PRs enabled for: ${prRepos.join(", ")}` : "draft PRs disabled (set PR_REPOS and GIT_PR_TOKEN in .env to enable)");
  const app = createApp({ store, redact, push, pr, startRun: (id) => { void executeRun({ store, launcher, redact, now: Date.now, sleep }, id); } });
  // Same origin for UI and API (npm run web:build first). Registered after the API routes, so /runs/* always wins.
  app.use("/*", serveStatic({ root: webRoot }));
  const srv = await startServer(app, { port: Number(process.env.PORT) || 3000 });
  console.log(`control plane listening on http://${srv.address}:${srv.port}`);
}

if (process.argv[1] && /api[\\/]main\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
