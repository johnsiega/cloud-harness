// Pure UI state behind the three panels (Reasoning | Terminal | Diff). No React, no DOM: unit-testable.
import type { TraceEvent } from "../../api/types.ts";

export type Phase = "idle" | "resuming" | "ready" | "running" | "done" | "error";

export type RunView = {
  phase: Phase;
  reasoning: { ts: number; text: string }[];
  terminal: { ts: number; kind: "stdout" | "stderr"; text: string }[];
  test?: { exitCode: number; summary: string; skipped?: string };
  diff?: string;
  startupMs?: number;
  firstTokenMs?: number;
  exitCode?: number;
  startedAt?: number; // ts of sandbox_resuming; anchor for relative times
};

export type Tone = "pending" | "active" | "ok" | "fail" | "skip";
export type Step = { key: string; label: string; tone: Tone; detail?: string; hero?: string };

// Derive the four-step rail from the view. Pure; the reducer already did the hard work.
export function railSteps(v: RunView): Step[] {
  const finished = v.phase === "done" || v.phase === "error";
  const sandbox: Step = v.startupMs !== undefined
    ? { key: "sandbox", label: "Sandbox ready", tone: "ok", hero: formatMs(v.startupMs), detail: "started from image" }
    : { key: "sandbox", label: "Sandbox", tone: v.phase === "resuming" ? "active" : finished ? "fail" : "pending", detail: v.phase === "resuming" ? "resuming snapshot" : undefined };

  const agentStarted = v.phase === "ready" || v.phase === "running" || finished;
  const agentDone = v.test !== undefined || v.diff !== undefined || (finished && v.reasoning.length + v.terminal.length > 0);
  const agent: Step = {
    key: "agent", label: "Agent",
    tone: agentDone ? "ok" : agentStarted ? "active" : "pending",
    detail: v.firstTokenMs !== undefined ? `first output ${formatMs(v.firstTokenMs)}` : agentStarted ? "waiting for first output" : undefined,
  };

  const tests: Step = !v.test
    ? { key: "tests", label: "Tests", tone: agentDone ? "fail" : "pending" }
    : v.test.skipped
      ? { key: "tests", label: "Tests not run", tone: "skip", detail: v.test.skipped }
      : { key: "tests", label: v.test.exitCode === 0 ? "Tests passed" : "Tests failed", tone: v.test.exitCode === 0 ? "ok" : "fail", detail: v.test.exitCode === 0 ? undefined : `exit ${v.test.exitCode}` };

  const lines = v.diff ? diffLines(v.diff) : [];
  const added = lines.filter((l) => l.kind === "add").length;
  const removed = lines.filter((l) => l.kind === "del").length;
  const patch: Step = v.diff === undefined
    ? { key: "patch", label: "Patch", tone: finished ? "fail" : "pending" }
    : v.diff.trim() === ""
      ? { key: "patch", label: "No changes", tone: "fail" }
      : { key: "patch", label: "Patch ready", tone: "ok", detail: `+${added} −${removed}` };
  return [sandbox, agent, tests, patch];
}

export function testTone(t: RunView["test"]): "ok" | "fail" | "skip" {
  return t?.skipped ? "skip" : t?.exitCode === 0 ? "ok" : "fail";
}

export type DiffLine ={ kind: "meta" | "hunk" | "add" | "del" | "ctx"; text: string };

export function initialView(): RunView {
  return { phase: "idle", reasoning: [], terminal: [] };
}

export function reduce(view: RunView, e: TraceEvent): RunView {
  const v: RunView = { ...view, reasoning: [...view.reasoning], terminal: [...view.terminal] };
  // Output only upgrades "ready" to "running"; output that races ahead of sandbox_ready must not skip the ready phase.
  const working = () => { if (v.phase === "ready") v.phase = "running"; };
  switch (e.type) {
    case "sandbox_resuming":
      v.phase = "resuming";
      v.startedAt = e.ts;
      break;
    case "sandbox_ready":
      v.phase = "ready";
      v.startupMs = e.startupMs;
      break;
    case "reasoning":
      v.reasoning.push({ ts: e.ts, text: e.text });
      if (v.firstTokenMs === undefined && v.startedAt !== undefined) v.firstTokenMs = e.ts - v.startedAt;
      working();
      break;
    case "stdout":
    case "stderr":
      v.terminal.push({ ts: e.ts, kind: e.type, text: e.text });
      working();
      break;
    case "test_result":
      v.test = { exitCode: e.exitCode, summary: e.summary, ...(e.skipped ? { skipped: e.skipped } : {}) };
      break;
    case "diff":
      v.diff = e.diff;
      break;
    case "done":
      v.exitCode = e.exitCode;
      v.phase = e.exitCode === 0 ? "done" : "error";
      break;
  }
  return v;
}

const FILE_HEADER = /^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename (from|to)|Binary files)/;

export function diffLines(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let inHunk = false;
  const lines = diff.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  for (const text of lines) {
    if (text.startsWith("diff --git")) { inHunk = false; out.push({ kind: "meta", text }); }
    else if (text.startsWith("@@")) { inHunk = true; out.push({ kind: "hunk", text }); }
    else if (!inHunk && FILE_HEADER.test(text)) out.push({ kind: "meta", text });
    else if (text.startsWith("+")) out.push({ kind: "add", text });
    else if (text.startsWith("-")) out.push({ kind: "del", text });
    else out.push({ kind: "ctx", text });
  }
  return out;
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
