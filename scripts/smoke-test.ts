// Phase 0 smoke test: build a Lambda MicroVM image (PHP + Node + Codex CLI), run one MicroVM,
// have Codex edit hospital-queue, run its tests, and bring back a non-empty diff.
//
//   node scripts/smoke-test.ts
//
// Env: SMOKE_BUCKET (S3 bucket for the image zip), SMOKE_BUILD_ROLE_ARN (Lambda build role),
//      AWS_REGION (default us-east-1), AWS_PROFILE (use the scoped IAM user, not root),
//      OPENROUTER_API_KEY (or a BOM-safe .env at the repo root),
//      SMOKE_REPO / SMOKE_TASK (optional overrides), SMOKE_IMAGE_ARN (skip the build, reuse an image).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MODEL_ID = "deepseek/deepseek-v4.1-flash";
export const EDITED_FILE = "app/Services/QueueEventLog.php";
export const RUN_HOOK_PAYLOAD_MAX_BYTES = 16384;

export type CodexEvent = Record<string, unknown>;

export interface ImageRequest {
  name: string;
  codeArtifact: { uri: string };
  baseImageArn: string;
  buildRoleArn: string;
  cpuConfigurations: { architecture: "X86_64" | "ARM_64" }[];
  hooks?: { port: number; microvmHooks: { run: "ENABLED" | "DISABLED" }; microvmImageHooks: { ready: "ENABLED" | "DISABLED" } };
}

export interface RunRequest {
  imageIdentifier: string;
  runHookPayload: string; // JSON: { REPO_URL, TASK, OPENROUTER_API_KEY, MODEL }
  ingressNetworkConnectors: string[];
  egressNetworkConnectors: string[];
  maximumDurationInSeconds: number;
  idlePolicy?: { autoResumeEnabled: boolean; maxIdleDurationSeconds: number; suspendedDurationSeconds: number };
}

export interface RunnerPost {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string; // JSON: { repoUrl, task }
}

export interface Report {
  imageBuildMs: number;
  runMs: number;
  submitToReadyMs: number;
  submitToFirstReasoningMs: number | null;
  codexExit: number;
  testExit: number;
  diffBytes: number;
  editedFilePresent: boolean;
}

const RUNNER_DIR = join(import.meta.dirname, "runner");
const lf = (s: string) => s.replace(/\r\n/g, "\n");
const runnerFile = (name: string) => lf(readFileSync(join(RUNNER_DIR, name), "utf8"));
const connector = (region: string, kind: string) => `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:${kind}`;

// ---------- image ----------
export function buildDockerfile(): string {
  return runnerFile("Dockerfile");
}

export function buildRunnerScript(): string {
  return runnerFile("run-task.sh");
}

export function buildImagePackage(): Record<string, string> {
  return { Dockerfile: buildDockerfile(), "run-task.sh": buildRunnerScript(), "server.mjs": runnerFile("server.mjs") };
}

export function buildImageRequest(o: { name: string; bucket: string; key: string; buildRoleArn: string; region?: string }): ImageRequest {
  return {
    name: o.name,
    codeArtifact: { uri: `s3://${o.bucket}/${o.key}` },
    baseImageArn: `arn:aws:lambda:${o.region ?? "us-east-1"}:aws:microvm-image:al2023-1`,
    buildRoleArn: o.buildRoleArn,
    cpuConfigurations: [{ architecture: "X86_64" }],
    // Without these, Lambda never calls /run and the OpenRouter key in runHookPayload is never delivered.
    hooks: { port: 8080, microvmHooks: { run: "ENABLED" }, microvmImageHooks: { ready: "ENABLED" } },
  };
}

// ---------- run ----------
const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
export function validateRepoUrl(url: string): boolean {
  return GITHUB_REPO.test(url.replace(/\.git$/, ""));
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][\w.-]*\/[\w.:-]+$/;

export function buildRunRequest(o: { imageArn: string; repoUrl: string; task: string; apiKey: string; region?: string; model?: string }): RunRequest {
  if (!validateRepoUrl(o.repoUrl)) throw new Error(`invalid repo URL (only https://github.com/<owner>/<repo>): ${o.repoUrl}`);
  const model = o.model ?? MODEL_ID;
  if (!MODEL_ID_PATTERN.test(model)) throw new Error(`invalid model id (expected <vendor>/<name>): ${JSON.stringify(model)}`);
  const runHookPayload = JSON.stringify({ REPO_URL: o.repoUrl, TASK: o.task, OPENROUTER_API_KEY: o.apiKey, MODEL: model });
  if (Buffer.byteLength(runHookPayload) > RUN_HOOK_PAYLOAD_MAX_BYTES) {
    throw new Error(`runHookPayload exceeds the ${RUN_HOOK_PAYLOAD_MAX_BYTES} byte (16 KB) limit`);
  }
  const region = o.region ?? "us-east-1";
  return {
    imageIdentifier: o.imageArn,
    runHookPayload,
    ingressNetworkConnectors: [connector(region, "HTTP_INGRESS")],
    egressNetworkConnectors: [connector(region, "INTERNET_EGRESS")],
    maximumDurationInSeconds: 1800,
  };
}

export function buildRunnerPost(o: { endpoint: string; authToken: string; repoUrl: string; task: string }): RunnerPost {
  return {
    url: `https://${o.endpoint.replace(/^https?:\/\//, "")}/`,
    method: "POST",
    headers: { "X-aws-proxy-auth": o.authToken, "X-aws-proxy-port": "8080", "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl: o.repoUrl, task: o.task }),
  };
}

// ---------- parsing ----------
export function parseCodexJsonl(output: string): { events: CodexEvent[]; malformed: number } {
  const events: CodexEvent[] = [];
  let malformed = 0;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) events.push(v);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

export function firstReasoningIndex(events: CodexEvent[]): number {
  return events.findIndex((e) => e.type === "reasoning" || (e.item as { type?: string } | undefined)?.type === "reasoning");
}

export function extractDiff(output: string): string {
  const lines = output.split(/\r?\n/);
  const s = lines.indexOf("__DIFF_START__");
  const e = s < 0 ? -1 : lines.indexOf("__DIFF_END__", s + 1);
  if (s < 0 || e < 0) return "";
  const body = lines.slice(s + 1, e);
  return body.length ? body.join("\n") + "\n" : "";
}

export function diffTouchesFile(diff: string, path: string): boolean {
  return diff.split(/\r?\n/).some((l) => {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
    return !!m && (m[1] === path || m[2] === path);
  });
}

// ---------- gate + report ----------
export function evaluateGate(o: { diff: string; editedFile: string }): { passed: boolean; reasons: string[]; exitCode: 0 | 1 } {
  const reasons: string[] = [];
  if (!o.diff.trim()) reasons.push("diff is empty");
  else if (!diffTouchesFile(o.diff, o.editedFile)) reasons.push(`diff does not include the edited file ${o.editedFile}`);
  return { passed: reasons.length === 0, reasons, exitCode: reasons.length === 0 ? 0 : 1 };
}

export function computeTimings(o: { submitMs: number; readyMs: number; firstReasoningMs: number | null }) {
  if (o.readyMs < o.submitMs) throw new Error("ready time is before submit time");
  return {
    submitToReadyMs: o.readyMs - o.submitMs,
    submitToFirstReasoningMs: o.firstReasoningMs === null ? null : o.firstReasoningMs - o.submitMs,
  };
}

export function formatReport(r: Report): string {
  const s = (ms: number | null) => (ms === null ? "n/a" : String(ms / 1000));
  return [
    `image_build_seconds: ${s(r.imageBuildMs)}`,
    `run_seconds: ${s(r.runMs)}`,
    `submit_to_sandbox_ready_seconds: ${s(r.submitToReadyMs)}`,
    `submit_to_first_reasoning_token_seconds: ${s(r.submitToFirstReasoningMs)}`,
    `codex_exit_code: ${r.codexExit}`,
    `test_exit_code: ${r.testExit}`,
    `diff_bytes: ${r.diffBytes}`,
    `edited_file_in_diff: ${r.editedFilePresent}`,
  ].join("\n") + "\n";
}

// ---------- create-image CLI + codex failure surfacing ----------
export function createImageCliArgs(req: ImageRequest): string[] {
  const args = [
    "lambda-microvms", "create-microvm-image",
    "--name", req.name,
    "--code-artifact", `uri=${req.codeArtifact.uri}`,
    "--base-image-arn", req.baseImageArn,
    "--build-role-arn", req.buildRoleArn,
    "--cpu-configurations", `architecture=${req.cpuConfigurations[0].architecture}`,
  ];
  if (req.hooks) args.push("--hooks", JSON.stringify(req.hooks));
  return args;
}

// Top-level `error` and `turn.failed` only: the item-level "Model metadata not found" warning is not a failure.
export function findCodexFailures(events: CodexEvent[]): CodexEvent[] {
  return events.filter((e) => e.type === "error" || e.type === "turn.failed");
}

export function formatCodexFailures(failures: CodexEvent[]): string {
  if (!failures.length) return "";
  return `codex_failures: ${failures.length}\n${failures.map((f) => JSON.stringify(f)).join("\n")}\n`;
}

export function decideExit(o: { events: CodexEvent[]; diff: string; editedFile: string }) {
  const failures = findCodexFailures(o.events);
  const gate = evaluateGate({ diff: o.diff, editedFile: o.editedFile });
  return { exitCode: (failures.length ? 2 : gate.exitCode) as 0 | 1 | 2, failures, gate };
}

// ---------- monitoring + batch statistics ----------
export interface Usage { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number }
export interface Activity { commands: number; failedCommands: number; fileChanges: number; agentMessages: number; reasoningItems: number; itemErrors: number }
export interface RunResult {
  index: number; model: string; microvmId: string;
  gatePassed: boolean; exitCode: 0 | 1 | 2;
  runMs: number; submitToReadyMs: number; submitToFirstReasoningMs: number | null;
  codexExit: number; testExit: number; diffBytes: number; editedFilePresent: boolean;
  activity: Activity; usage: Usage | null;
  eventsRaw: string; diff: string; stderrTail: string[];
}
export interface BatchSummary {
  runs: number; passed: number; passRate: number; emptyDiffs: number; codexFailures: number; runsWithFileChange: number;
  medianRunMs: number; minRunMs: number; maxRunMs: number; medianReadyMs: number; totalInputTokens: number; totalOutputTokens: number;
}
type Item = { type?: string; command?: string; exit_code?: number | null; text?: string; message?: string; changes?: { path: string; kind: string }[] };
const itemOf = (e: CodexEvent): Item => (e.item as Item | undefined) ?? {};
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const num = (v: unknown) => (typeof v === "number" ? v : 0);

export function extractUsage(events: CodexEvent[]): Usage | null {
  const turns = events.filter((e) => e.type === "turn.completed" && e.usage);
  if (!turns.length) return null;
  const sum = (k: string) => turns.reduce((a, e) => a + num((e.usage as Record<string, unknown>)[k]), 0);
  return { inputTokens: sum("input_tokens"), cachedInputTokens: sum("cached_input_tokens"), outputTokens: sum("output_tokens"), reasoningTokens: sum("reasoning_output_tokens") };
}

export function summarizeCodexActivity(events: CodexEvent[]): Activity {
  const done = events.filter((e) => e.type === "item.completed").map(itemOf);
  const count = (t: string) => done.filter((i) => i.type === t).length;
  return {
    commands: count("command_execution"),
    failedCommands: done.filter((i) => i.type === "command_execution" && i.exit_code !== 0).length,
    fileChanges: count("file_change"),
    agentMessages: count("agent_message"),
    reasoningItems: count("reasoning"),
    itemErrors: count("error"),
  };
}

// One live line per interesting event; null for bookkeeping.
export function describeEvent(e: CodexEvent): string | null {
  const i = itemOf(e);
  if (e.type === "item.completed") {
    if (i.type === "command_execution") return `cmd exit=${i.exit_code}: ${clip(i.command ?? "", 100)}`;
    if (i.type === "agent_message") return `msg: ${clip(i.text ?? "", 120)}`;
    if (i.type === "file_change") return `file_change: ${(i.changes ?? []).map((c) => `${c.path} (${c.kind})`).join(", ")}`;
    if (i.type === "reasoning") return `reasoning: ${clip(i.text ?? "", 100)}`;
    if (i.type === "error") return `item_error: ${clip(i.message ?? "", 120)}`;
    return null;
  }
  if (e.type === "error") return `ERROR: ${e.message}`;
  if (e.type === "turn.failed") return `TURN_FAILED: ${(e.error as { message?: string } | undefined)?.message}`;
  if (e.type === "turn.completed" && e.usage) {
    const u = e.usage as Record<string, unknown>;
    return `turn.completed in=${num(u.input_tokens)} out=${num(u.output_tokens)} reasoning=${num(u.reasoning_output_tokens)}`;
  }
  return null;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function summarizeRuns(runs: RunResult[]): BatchSummary {
  const passed = runs.filter((r) => r.gatePassed).length;
  const runMs = runs.map((r) => r.runMs);
  return {
    runs: runs.length,
    passed,
    passRate: runs.length ? passed / runs.length : 0,
    emptyDiffs: runs.filter((r) => r.diffBytes === 0).length,
    codexFailures: runs.filter((r) => r.exitCode === 2).length,
    runsWithFileChange: runs.filter((r) => r.activity.fileChanges > 0).length,
    medianRunMs: median(runMs),
    minRunMs: runs.length ? Math.min(...runMs) : 0,
    maxRunMs: runs.length ? Math.max(...runMs) : 0,
    medianReadyMs: median(runs.map((r) => r.submitToReadyMs)),
    totalInputTokens: runs.reduce((a, r) => a + (r.usage?.inputTokens ?? 0), 0),
    totalOutputTokens: runs.reduce((a, r) => a + (r.usage?.outputTokens ?? 0), 0),
  };
}

export function formatBatchSummary(s: BatchSummary, model: string): string {
  const sec = (ms: number) => String(ms / 1000);
  return [
    `model: ${model}`,
    `runs: ${s.runs}`,
    `passed: ${s.passed}/${s.runs} (${(s.passRate * 100).toFixed(1)}%)`,
    `empty_diffs: ${s.emptyDiffs}`,
    `codex_failures: ${s.codexFailures}`,
    `runs_with_file_change: ${s.runsWithFileChange}`,
    `run_seconds_median: ${sec(s.medianRunMs)}`,
    `run_seconds_min: ${sec(s.minRunMs)}`,
    `run_seconds_max: ${sec(s.maxRunMs)}`,
    `ready_seconds_median: ${sec(s.medianReadyMs)}`,
    `input_tokens_total: ${s.totalInputTokens}`,
    `output_tokens_total: ${s.totalOutputTokens}`,
  ].join("\n") + "\n";
}

// Per-run files for later inspection; meta.json stays small, the big payloads get their own files.
export function runArtifacts(r: RunResult): Record<string, string> {
  const { eventsRaw, diff, stderrTail, ...meta } = r;
  return {
    "events.jsonl": eventsRaw.replace(/\n*$/, "") + "\n",
    "diff.patch": diff,
    "stderr.txt": stderrTail.join("\n") + "\n",
    "meta.json": JSON.stringify(meta, null, 2) + "\n",
  };
}

// ---------- executable: the real AWS call sequence (not unit-tested; run only after the IAM step) ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadEnvKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const p = join(import.meta.dirname, "..", ".env");
  if (!existsSync(p)) throw new Error("OPENROUTER_API_KEY not set and no .env found");
  const line = readFileSync(p, "utf8").replace(/^﻿/, "").split(/\r?\n/).find((l) => l.startsWith("OPENROUTER_API_KEY="));
  const v = line?.slice("OPENROUTER_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
  if (!v) throw new Error("OPENROUTER_API_KEY missing from .env");
  return v;
}

function aws(region: string, ...args: string[]): any {
  const out = execFileSync("aws", [...args, "--region", region, "--output", "json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : {};
}

function makeZip(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mvm-pkg-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  const zip = join(tmpdir(), `mvm-${Date.now()}.zip`);
  // Absolute path: under Git Bash plain `tar` is GNU tar, which can't write zips and parses "C:" as a remote host.
  if (process.platform === "win32") execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-a", "-cf", zip, "-C", dir, ...Object.keys(files)]);
  else execFileSync("zip", ["-qj", zip, ...Object.keys(files).map((f) => join(dir, f))]);
  rmSync(dir, { recursive: true, force: true });
  return zip;
}

interface RunCtx { region: string; imageArn: string; repoUrl: string; task: string; apiKey: string; model: string; index: number }

const emptyActivity: Activity = { commands: 0, failedCommands: 0, fileChanges: 0, agentMessages: 0, reasoningItems: 0, itemErrors: 0 };

// One MicroVM: run -> ready -> POST task -> stream + monitor events -> collect -> terminate.
async function runOnce(c: RunCtx): Promise<RunResult> {
  const run = buildRunRequest({ imageArn: c.imageArn, repoUrl: c.repoUrl, task: c.task, apiKey: c.apiKey, region: c.region, model: c.model });
  const inputFile = join(mkdtempSync(join(tmpdir(), "mvm-run-")), "run.json"); // keeps the key out of the process list
  writeFileSync(inputFile, JSON.stringify(run), { mode: 0o600 });

  const submitMs = Date.now();
  const stamp = () => `[+${((Date.now() - submitMs) / 1000).toFixed(1)}s]`;
  const started = aws(c.region, "lambda-microvms", "run-microvm", "--cli-input-json", `file://${inputFile.replace(/\\/g, "/")}`);
  rmSync(inputFile, { force: true });
  const microvmId: string = started.microvmId;
  console.error(`${stamp()} run-microvm accepted: ${microvmId} (${started.state ?? "?"})`);
  try {
    const token = aws(c.region, "lambda-microvms", "create-microvm-auth-token", "--microvm-identifier", microvmId,
      "--expiration-in-minutes", "60", "--allowed-ports", '[{"allPorts":{}}]').authToken["X-aws-proxy-auth"];
    const headers = { "X-aws-proxy-auth": token, "X-aws-proxy-port": "8080" };

    let readyMs = 0;
    while (!readyMs) {
      if (Date.now() - submitMs > 5 * 60_000) throw new Error("sandbox not ready after 5 min");
      try {
        const r = await fetch(`https://${started.endpoint}/health`, { headers });
        if (r.ok) readyMs = Date.now();
      } catch { /* endpoint not routable yet */ }
      if (!readyMs) await sleep(250);
    }
    console.error(`${stamp()} sandbox ready; microvm state: ${aws(c.region, "lambda-microvms", "get-microvm", "--microvm-identifier", microvmId).state}`);

    const post = buildRunnerPost({ endpoint: started.endpoint, authToken: token, repoUrl: c.repoUrl, task: c.task });
    const pr = await fetch(post.url, { method: post.method, headers: post.headers, body: post.body });
    if (pr.status !== 202) throw new Error(`runner rejected the task: ${pr.status} ${await pr.text()}`);

    const lines: string[] = [];
    let next = 0;
    let firstReasoningMs: number | null = null;
    let stderrTail: string[] = [];
    const deadline = Date.now() + 20 * 60_000;
    for (;;) {
      const ev = await (await fetch(`https://${started.endpoint}/events?since=${next}`, { headers })).json();
      const arrivedAt = Date.now();
      if (ev.lines.length) {
        const parsed = parseCodexJsonl(ev.lines.join("\n")).events;
        if (firstReasoningMs === null && firstReasoningIndex(parsed) >= 0) firstReasoningMs = arrivedAt; // poll-interval resolution (~500 ms)
        for (const e of parsed) {
          const d = e.type === "codex_exit" || e.type === "test_result" ? `${e.type} exitCode=${e.exitCode}` : describeEvent(e); // live monitor
          if (d) console.error(`${stamp()} ${d}`);
        }
        lines.push(...ev.lines);
      }
      next = ev.next;
      if (ev.done) { stderrTail = ev.stderrTail; break; }
      if (Date.now() > deadline) throw new Error("run did not finish within 20 min");
      await sleep(500);
    }
    const runMs = Date.now() - submitMs;

    const all = lines.join("\n");
    const events = parseCodexJsonl(all).events;
    const exitOf = (type: string) => (events.find((e) => e.type === type)?.exitCode as number | undefined) ?? -1;
    const diff = extractDiff(all);
    const verdict = decideExit({ events, diff, editedFile: EDITED_FILE });
    const t = computeTimings({ submitMs, readyMs, firstReasoningMs });
    // A model-call failure must be visible, verbatim, and replaces the gate verdict.
    if (verdict.failures.length) console.error(formatCodexFailures(verdict.failures) + `--- runner stderr tail ---\n${stderrTail.join("\n")}`);
    else if (!verdict.gate.passed) console.error(`GATE FAILED: ${verdict.gate.reasons.join("; ")}`);
    else console.error("GATE PASSED");
    if (exitOf("test_result") !== 0) console.error(`--- runner stderr tail (test step) ---\n${stderrTail.join("\n")}`);
    return {
      index: c.index, model: c.model, microvmId,
      gatePassed: verdict.gate.passed && !verdict.failures.length, exitCode: verdict.exitCode,
      runMs, ...t, codexExit: exitOf("codex_exit"), testExit: exitOf("test_result"),
      diffBytes: Buffer.byteLength(diff), editedFilePresent: diffTouchesFile(diff, EDITED_FILE),
      activity: summarizeCodexActivity(events), usage: extractUsage(events), eventsRaw: all, diff, stderrTail,
    };
  } finally {
    try { aws(c.region, "lambda-microvms", "terminate-microvm", "--microvm-identifier", microvmId); console.error(`${stamp()} terminated ${microvmId}`); }
    catch (e) { console.error("terminate failed:", (e as Error).message); }
  }
}

async function main(): Promise<number> {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const repoUrl = process.env.SMOKE_REPO ?? "https://github.com/jyvnn/hospital-queue";
  const task =
    process.env.SMOKE_TASK ??
    `Add a one-line comment directly above the enabled() method in ${EDITED_FILE} explaining what it checks. Do not change any behavior.`;
  const model = process.env.SMOKE_MODEL ?? MODEL_ID;
  const runs = Math.max(1, Number(process.env.SMOKE_RUNS) || 1);
  const outDir = process.env.SMOKE_OUT_DIR;
  const apiKey = loadEnvKey();
  let imageArn = process.env.SMOKE_IMAGE_ARN ?? "";
  let imageBuildMs = 0;

  if (!imageArn) {
    const bucket = process.env.SMOKE_BUCKET;
    const buildRoleArn = process.env.SMOKE_BUILD_ROLE_ARN;
    if (!bucket || !buildRoleArn) throw new Error("set SMOKE_BUCKET and SMOKE_BUILD_ROLE_ARN (or SMOKE_IMAGE_ARN)");
    const name = `hq-smoke-${Date.now()}`;
    const key = `smoke/${name}.zip`;
    const zip = makeZip(buildImagePackage());
    execFileSync("aws", ["s3", "cp", zip, `s3://${bucket}/${key}`, "--region", region], { stdio: "inherit" });
    const req = buildImageRequest({ name, bucket, key, buildRoleArn, region });
    imageArn = aws(region, ...createImageCliArgs(req)).imageArn;
    if (!imageArn) throw new Error("create-microvm-image returned no imageArn");
    console.error(`image build started: ${imageArn}`);
  }

  // Wait for the image (ours, or an in-flight one adopted via SMOKE_IMAGE_ARN). get-microvm-image needs the ARN, not the name.
  const waitStart = Date.now();
  for (;;) {
    const img = aws(region, "lambda-microvms", "get-microvm-image", "--image-identifier", imageArn);
    console.error(`image ${img.name ?? imageArn}: ${img.state}`);
    if (img.state === "CREATED") {
      const span = Date.parse(img.updatedAt) - Date.parse(img.createdAt); // service-side build time
      imageBuildMs = span > 0 ? span : Date.now() - waitStart;
      break;
    }
    if (/FAIL/.test(img.state)) throw new Error(`image build failed (${img.state}); see CloudWatch /aws/lambda-microvms/${img.name}`);
    if (Date.now() - waitStart > 30 * 60_000) throw new Error("image build timed out after 30 min");
    await sleep(10_000);
  }

  const results: RunResult[] = [];
  for (let n = 1; n <= runs; n++) {
    console.error(`\n===== run ${n}/${runs}  model=${model} =====`);
    let r: RunResult;
    try {
      r = await runOnce({ region, imageArn, repoUrl, task, apiKey, model, index: n });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`run ${n} infrastructure error: ${msg}`);
      r = { index: n, model, microvmId: "", gatePassed: false, exitCode: 2, runMs: 0, submitToReadyMs: 0, submitToFirstReasoningMs: null,
        codexExit: -1, testExit: -1, diffBytes: 0, editedFilePresent: false, activity: emptyActivity, usage: null, eventsRaw: "", diff: "", stderrTail: [msg] };
    }
    results.push(r);
    process.stdout.write(`--- run ${n} ---\n` + formatReport({ imageBuildMs, ...r }));
    if (outDir) {
      const dir = join(outDir, model.replace(/[^\w.-]+/g, "_"), `run-${n}`);
      mkdirSync(dir, { recursive: true });
      for (const [file, body] of Object.entries(runArtifacts(r))) writeFileSync(join(dir, file), body);
    }
  }
  process.stdout.write("--- summary ---\n" + formatBatchSummary(summarizeRuns(results), model));
  return results.some((r) => r.exitCode === 2) ? 2 : results.every((r) => r.gatePassed) ? 0 : 1;
}

if (process.argv[1] && /smoke-test\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().then((c) => process.exit(c), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(2); });
}
