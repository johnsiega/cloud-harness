// Real concurrency test: start K real runs through the control plane's HTTP API at once, wait for all of them, report each.
// K steps up from 2 and stops at the first step that is not fully successful (usually the account's MicroVM memory quota).
// kill-all runs after every step and at the end. This spends real money (AWS plus model fees); see docs/PHASE_5_6_PLAN.md.
//
//   AWS_PROFILE=<your-profile> MICROVM_IMAGE_ARN=<arn> npm start      (in one terminal)
//   AWS_PROFILE=<your-profile> node scripts/load-real.ts              (in another; LOAD_START_K / LOAD_MAX_K override 2 and 5)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAwsMicrovms } from "../api/aws-microvms.ts";
import { killAll, planKill } from "./kill-all.ts";

export type Http = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ status: number; json: any }>;
export type LoadDeps = { http: Http; sleep: (ms: number) => Promise<void>; now: () => number; killAll: () => Promise<void> };
export type LoadOpts = { startK?: number; maxK?: number; pollMs?: number; runTimeoutMs?: number; startGapMs?: number };

export type RunSummary = {
  index: number;
  runId?: string;
  status: "done" | "error" | "timeout" | "rejected";
  startupMs?: number;
  firstOutputMs?: number;
  durationMs?: number;
  diffAdded?: number;
  diffRemoved?: number;
  finalMessage?: string;
  error?: string;
  quota: boolean;
};
export type StepResult = { k: number; runs: RunSummary[]; ok: boolean; quota: boolean };
export type LoadReport = { steps: StepResult[]; highestFullySucceeded: number; stoppedBy: "max" | "quota" | "failure" };

const REPO_URL = "https://github.com/jyvnn/hospital-queue";
const isQuota = (s: string | undefined) => /quota/i.test(s ?? "");

// Same small job per run, made distinct (the control plane rejects a duplicate repo+task while one is active).
export function taskFor(i: number): string {
  return `add a one-line comment directly above the enabled() method; start the comment with "Run ${i + 1}:"`;
}

export function summarizeRun(index: number, record: any, durationMs: number): RunSummary {
  const events: any[] = record.events ?? [];
  const lastText = (type: string) => events.filter((e) => e.type === type && typeof e.text === "string").at(-1)?.text as string | undefined;
  const stderr = lastText("stderr");
  const message = lastText("reasoning");
  const s: RunSummary = {
    index,
    status: record.status === "done" ? "done" : "error",
    durationMs,
    quota: events.some((e) => e.type === "stderr" && isQuota(e.text)),
  };
  if (record.startupMs !== undefined) s.startupMs = record.startupMs;
  if (record.firstTokenMs !== undefined) s.firstOutputMs = record.firstTokenMs;
  if (message !== undefined) s.finalMessage = message.slice(0, 200);
  if (s.status === "error" && stderr !== undefined) s.error = stderr;
  if (typeof record.diff === "string") Object.assign(s, countDiff(record.diff));
  return s;
}

// +/- lines inside hunks only, so the "--- a/f" and "+++ b/f" file headers are not counted.
function countDiff(diff: string): { diffAdded: number; diffRemoved: number } {
  let diffAdded = 0, diffRemoved = 0, inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) inHunk = false;
    else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && line.startsWith("+")) diffAdded++;
    else if (inHunk && line.startsWith("-")) diffRemoved++;
  }
  return { diffAdded, diffRemoved };
}

export async function runStep(deps: LoadDeps, k: number, opts: LoadOpts = {}): Promise<StepResult> {
  const gap = opts.startGapMs ?? 250; // RunMicrovm is limited to 5/s
  const pollMs = opts.pollMs ?? 1000;
  const timeoutMs = opts.runTimeoutMs ?? 10 * 60_000;
  const runs: RunSummary[] = new Array(k);
  const pending: { index: number; id: string; submitMs: number }[] = [];

  for (let i = 0; i < k; i++) {
    if (i > 0) await deps.sleep(gap);
    const submitMs = deps.now();
    const res = await deps.http("POST", "/runs", { repoUrl: REPO_URL, task: taskFor(i) });
    if (res.status === 202) pending.push({ index: i, id: res.json.id, submitMs });
    else {
      const error = String(res.json?.error ?? `HTTP ${res.status}`);
      runs[i] = { index: i, status: "rejected", error, quota: isQuota(error) };
    }
  }

  while (pending.length > 0) {
    for (const p of [...pending]) {
      const { json } = await deps.http("GET", `/runs/${p.id}`);
      const elapsed = deps.now() - p.submitMs;
      if (json.status === "done" || json.status === "error") runs[p.index] = { ...summarizeRun(p.index, json, elapsed), runId: p.id };
      else if (elapsed >= timeoutMs) runs[p.index] = { index: p.index, runId: p.id, status: "timeout", durationMs: elapsed, quota: false };
      else continue;
      pending.splice(pending.indexOf(p), 1);
    }
    if (pending.length > 0) await deps.sleep(pollMs);
  }
  return { k, runs, ok: runs.every((r) => r.status === "done"), quota: runs.some((r) => r.quota) };
}

export async function runLoad(deps: LoadDeps, opts: LoadOpts = {}): Promise<LoadReport> {
  const report: LoadReport = { steps: [], highestFullySucceeded: 0, stoppedBy: "max" };
  for (let k = opts.startK ?? 2; k <= (opts.maxK ?? 5); k++) {
    let step: StepResult;
    try {
      step = await runStep(deps, k, opts);
    } finally {
      await deps.killAll(); // after every step, and on a crash: never leave VMs behind
    }
    report.steps.push(step);
    if (step.ok) report.highestFullySucceeded = k;
    else { report.stoppedBy = step.quota ? "quota" : "failure"; break; }
  }
  return report;
}

const sec = (ms: number | undefined) => (ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`);

export function formatReport(report: LoadReport): string {
  if (report.steps.length === 0) return "No steps ran.";
  const lines = ["Real runs through the control plane on real MicroVMs (no simulated data)."];
  for (const s of report.steps) {
    lines.push("", `K=${s.k}: ${s.ok ? `all ${s.k} runs succeeded` : "not fully successful"}`);
    for (const r of s.runs) {
      const diff = r.diffAdded === undefined ? "" : `  +${r.diffAdded} -${r.diffRemoved}`;
      lines.push(`  #${r.index + 1} ${r.status}  startup ${sec(r.startupMs)}  first output ${sec(r.firstOutputMs)}  total ${sec(r.durationMs)}${diff}${r.finalMessage ? `  "${r.finalMessage}"` : ""}${r.error ? `  error: ${r.error}` : ""}`);
    }
  }
  lines.push("", `Highest K that fully succeeded: ${report.highestFullySucceeded}`);
  lines.push(report.stoppedBy === "quota" ? "Stopped because of the quota (the account's MicroVM memory limit)."
    : report.stoppedBy === "failure" ? "Stopped because a run failed for a reason other than the quota."
    : "Stopped at the largest K tried.");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const base = process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:3000";
  const aws = createAwsMicrovms({ region: process.env.AWS_REGION ?? "us-east-1" });
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const deps: LoadDeps = {
    now: Date.now,
    sleep,
    http: async (method, path, body) => {
      const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    },
    killAll: async () => {
      const r = await killAll({ aws, sleep }, { yes: true });
      if (r.failed.length > 0) throw new Error(`kill-all failed for ${r.failed.map((f) => f.microvmId).join(", ")}`);
      // TERMINATING VMs may still hold memory against the quota, which would fake a quota failure in the next step: wait until they are gone.
      for (let i = 0; i < 60 && planKill(await aws.list()).length > 0; i++) await sleep(1000);
    },
  };
  const report = await runLoad(deps, { startK: Number(process.env.LOAD_START_K) || 2, maxK: Number(process.env.LOAD_MAX_K) || 5 });
  console.log(formatReport(report));
  const dir = join(import.meta.dirname, "..", "docs", "measurements");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "load-real.json"), JSON.stringify({ measuredAt: new Date().toISOString(), report }, null, 2) + "\n");
}

if (process.argv[1] && /load-real\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(2); });
}
