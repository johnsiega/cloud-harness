// Data contracts from Development_Process.md section 6, plus the seams the control plane is tested through.
import type { RunRequest as MicrovmRunInput } from "../scripts/smoke-test.ts";

export type RunRequest = {
  repoUrl: string;
  task: string;
  model?: string; // default "deepseek/deepseek-v4.1-flash"
  testCommand?: string; // "skip", or a shell command run inside the VM; absent = auto-detect there
};

export type TraceEvent =
  | { type: "sandbox_resuming"; ts: number }
  | { type: "sandbox_ready"; ts: number; startupMs: number }
  | { type: "reasoning"; ts: number; text: string }
  | { type: "stdout"; ts: number; text: string }
  | { type: "stderr"; ts: number; text: string }
  | { type: "test_result"; ts: number; exitCode: number; summary: string; skipped?: string }
  | { type: "diff"; ts: number; diff: string }
  | { type: "done"; ts: number; exitCode: number };

export type RunStatus = "pending" | "running" | "done" | "error";

export type RunRecord = {
  id: string;
  request: RunRequest;
  status: RunStatus;
  events: TraceEvent[];
  diff?: string;
  microvmId?: string;
  push?: { branch: string; commit: string; url: string }; // set once the diff was pushed
  pr?: { branch: string; commit: string; number?: number; url?: string }; // branch set once pushed; number/url once the draft PR exists
  baseCommit?: string; // 40-hex commit the runner cloned; the push applies the diff on top of exactly this
  createdAt: number;
  startupMs?: number;
  firstTokenMs?: number;
};

export interface Redactor {
  text(s: string): string;
  event(e: TraceEvent): TraceEvent;
}

export type CreateResult = { ok: true; record: RunRecord } | { ok: false; reason: "duplicate"; existingId: string };

export interface RunStore {
  create(req: RunRequest): CreateResult;
  get(id: string): RunRecord | undefined;
  append(id: string, e: TraceEvent): void;
  update(id: string, patch: Partial<Pick<RunRecord, "status" | "diff" | "microvmId" | "baseCommit" | "push" | "pr" | "startupMs" | "firstTokenMs">>): void;
  subscribe(id: string, fn: (e: TraceEvent) => void): () => void;
  sweep(): number;
}

// ---- sandbox seams ----
export interface SandboxHandle { microvmId: string; endpoint: string; authToken: string; submitMs: number; readyMs: number }
export interface PollResult { lines: string[]; next: number; done: boolean; exitCode: number | null; stderrTail: string[] }

export interface MicroVMLauncher {
  launch(req: RunRequest): Promise<SandboxHandle>;
  start(h: SandboxHandle, req: RunRequest): Promise<void>;
  poll(h: SandboxHandle, since: number): Promise<PollResult>;
  terminate(h: SandboxHandle): Promise<void>;
}

// Thin wrapper over the AWS SDK / CLI; mocked in unit tests.
export interface AwsMicrovms {
  run(input: MicrovmRunInput): Promise<{ microvmId: string; endpoint: string }>;
  authToken(microvmId: string): Promise<string>;
  terminate(microvmId: string): Promise<void>;
  suspend(microvmId: string): Promise<void>;
  resume(microvmId: string): Promise<void>;
  describe(microvmId: string): Promise<{ state: string; endpoint?: string }>;
  /** Every MicroVM in the account and Region, or only those from one image. Follows pagination. */
  list(imageArn?: string): Promise<{ microvmId: string; state: string }[]>;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;
