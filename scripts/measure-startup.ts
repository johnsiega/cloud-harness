// Cold vs warm start measurement. One fresh MicroVM per cycle, three timings on the same /health probe (default every 50 ms):
//   cold    = run-microvm call -> first healthy /health (includes the auth-token call)
//   suspend = suspend-microvm call -> describe() reports SUSPENDED
//   (dwell) = sleep(dwellMs), never counted
//   warm    = resume-microvm call -> describe() reports RUNNING (endpoint re-read) -> fresh token -> first healthy /health
// Measurement VMs never receive the API key, and every VM is terminated in `finally`.
//
//   AWS_PROFILE=<your-profile> MICROVM_IMAGE_ARN=<arn> node scripts/measure-startup.ts      (spends a little money; see docs/PHASE_4_PLAN.md)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Stats = { n: number; min: number; median: number; p95: number; max: number };

export type MeasureAws = {
  run(input: any): Promise<{ microvmId: string; endpoint: string }>;
  authToken(microvmId: string): Promise<string>;
  suspend(microvmId: string): Promise<void>;
  resume(microvmId: string): Promise<void>;
  describe(microvmId: string): Promise<{ state: string; endpoint?: string }>;
  terminate(microvmId: string): Promise<void>;
};

export type MeasureDeps = {
  aws: MeasureAws;
  fetch: (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export type CycleOpts = { imageArn: string; dwellMs: number; healthPollMs?: number; statePollMs?: number; timeoutMs?: number };
export type CycleResult = { coldMs: number; suspendMs: number; warmMs: number; endpointChanged: boolean };

export type MeasurementResult = {
  dwellMs: number;
  cycles: CycleResult[];
  failures: { cycle: number; error: string }[];
  stoppedEarly?: string;
  cold: Stats;
  warm: Stats;
  suspend: Stats;
};

const connector = (region: string, kind: string) => `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:${kind}`;

export function summarizeLatencies(ms: number[]): Stats {
  const n = ms.length;
  if (n === 0) return { n: 0, min: 0, median: 0, p95: 0, max: 0 };
  const s = [...ms].sort((a, b) => a - b);
  const mid = n >> 1;
  const median = n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  const rank = Math.ceil((95 * n) / 100); // nearest-rank, in integer math so 0.95 * 20 cannot round the wrong way
  return { n, min: s[0], median, p95: s[rank - 1], max: s[n - 1] };
}

// The run input for a measurement VM: an EMPTY run hook payload (no key, no model, no task) and auto-resume off,
// so a stray request can never wake a VM and corrupt a warm sample.
export function buildMeasureInput(imageArn: string, dwellMs: number): any {
  const region = imageArn.split(":")[3] || "us-east-1";
  const dwellS = Math.ceil(dwellMs / 1000);
  return {
    imageIdentifier: imageArn,
    runHookPayload: "{}",
    ingressNetworkConnectors: [connector(region, "HTTP_INGRESS")],
    egressNetworkConnectors: [connector(region, "INTERNET_EGRESS")],
    maximumDurationInSeconds: Math.min(28800, Math.max(1800, dwellS + 900)), // suspended time counts toward the cap
    idlePolicy: { autoResumeEnabled: false, maxIdleDurationSeconds: 3600, suspendedDurationSeconds: Math.min(28800, Math.max(3600, dwellS + 600)) },
  };
}

export async function measureCycle(d: MeasureDeps, o: CycleOpts): Promise<CycleResult> {
  const healthPollMs = o.healthPollMs ?? 50;
  const statePollMs = o.statePollMs ?? 100;
  const timeoutMs = o.timeoutMs ?? 120_000;

  const waitHealthy = async (endpoint: string, token: string, since: number, label: string) => {
    for (;;) {
      try {
        const r = await d.fetch(`https://${endpoint}/health`, { headers: { "X-aws-proxy-auth": token, "X-aws-proxy-port": "8080" } });
        if (r.ok) return;
      } catch { /* endpoint not routable yet: same as not ready */ }
      if (d.now() - since >= timeoutMs) throw new Error(`sandbox not ready after ${timeoutMs} ms (${label})`);
      await d.sleep(healthPollMs);
    }
  };

  const waitState = async (id: string, want: string, since: number, label: string) => {
    for (;;) {
      const s = await d.aws.describe(id);
      if (s.state === want) return s;
      if (/^(TERMINATING|TERMINATED|FAILED)/.test(s.state)) throw new Error(`unexpected state ${s.state} while waiting for ${want}`);
      if (d.now() - since >= timeoutMs) throw new Error(`${label} timed out after ${timeoutMs} ms waiting for ${want}`);
      await d.sleep(statePollMs);
    }
  };

  const t0 = d.now();
  const { microvmId, endpoint } = await d.aws.run(buildMeasureInput(o.imageArn, o.dwellMs)); // a failing launch has nothing to terminate
  try {
    const token = await d.aws.authToken(microvmId);
    await waitHealthy(endpoint, token, t0, "cold");
    const coldMs = d.now() - t0;

    const s0 = d.now();
    await d.aws.suspend(microvmId);
    await waitState(microvmId, "SUSPENDED", s0, "suspend");
    const suspendMs = d.now() - s0;

    await d.sleep(o.dwellMs);

    const r0 = d.now();
    await d.aws.resume(microvmId);
    const running = await waitState(microvmId, "RUNNING", r0, "resume");
    const endpoint2 = running.endpoint ?? endpoint; // whether the endpoint survives a suspend is not documented, so read it again
    const token2 = await d.aws.authToken(microvmId); // the old token may have expired during a long dwell
    await waitHealthy(endpoint2, token2, r0, "warm");
    const warmMs = d.now() - r0;

    return { coldMs, suspendMs, warmMs, endpointChanged: endpoint2 !== endpoint };
  } finally {
    try { await d.aws.terminate(microvmId); } catch { /* cleanup must never hide the real result or error */ }
  }
}

const isQuota = (e: unknown) => /quota/i.test(`${(e as Error)?.name} ${(e as Error)?.message}`);

export async function runMeasurement(d: MeasureDeps, o: CycleOpts & { cycles: number }): Promise<MeasurementResult> {
  const cycles: CycleResult[] = [];
  const failures: { cycle: number; error: string }[] = [];
  let stoppedEarly: string | undefined;
  for (let i = 1; i <= o.cycles; i++) {
    try {
      cycles.push(await measureCycle(d, o));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failures.push({ cycle: i, error });
      if (isQuota(e)) { stoppedEarly = `quota exceeded: ${error}`; break; }
    }
  }
  return {
    dwellMs: o.dwellMs, cycles, failures, ...(stoppedEarly ? { stoppedEarly } : {}),
    cold: summarizeLatencies(cycles.map((c) => c.coldMs)),
    warm: summarizeLatencies(cycles.map((c) => c.warmMs)),
    suspend: summarizeLatencies(cycles.map((c) => c.suspendMs)),
  };
}

const NOTE = "note: readiness is the submit (cold) or resume (warm) call to the first healthy /health response; it excludes repo clone and model latency";

export function formatMeasurement(r: MeasurementResult): string {
  const line = (label: string, s: Stats) => `${label}: n=${s.n} min=${Math.round(s.min)} median=${Math.round(s.median)} p95=${Math.round(s.p95)} max=${Math.round(s.max)}`;
  return [
    `dwell_seconds: ${r.dwellMs / 1000}`,
    `cycles_ok: ${r.cycles.length} of ${r.cycles.length + r.failures.length}`,
    line("cold_ms", r.cold),
    line("warm_ms", r.warm),
    line("suspend_ms", r.suspend),
    ...r.failures.map((f) => `failure cycle ${f.cycle}: ${f.error}`),
    ...(r.stoppedEarly ? [`stopped_early: ${r.stoppedEarly}`] : []),
    NOTE,
  ].join("\n") + "\n";
}

// The pool is only worth building if, on BOTH dwell samples, warm is clearly faster and no worse in the tail, and nothing failed.
export function evaluateWarmGate(sets: MeasurementResult[]): { pass: boolean; reasons: string[] } {
  if (sets.length < 2) return { pass: false, reasons: ["need both dwell samples (a short and a long one) before deciding"] };
  const reasons: string[] = [];
  for (const s of sets) {
    const label = `${s.dwellMs / 1000} s dwell`;
    if (s.failures.length) reasons.push(`${label}: ${s.failures.length} cycle(s) failed`);
    if (s.stoppedEarly) reasons.push(`${label}: stopped early (${s.stoppedEarly})`);
    if (s.cold.n === 0 || s.warm.n === 0) { reasons.push(`${label}: no successful cycles`); continue; }
    const diff = s.cold.median - s.warm.median;
    if (diff * 10 < s.cold.median * 3) reasons.push(`${label}: warm median ${Math.round(s.warm.median)} ms is not at least 30% faster than cold ${Math.round(s.cold.median)} ms`);
    if (diff < 500) reasons.push(`${label}: warm median is only ${Math.round(diff)} ms faster than cold, under the 500 ms minimum`);
    if (s.warm.p95 > s.cold.p95) reasons.push(`${label}: warm p95 ${Math.round(s.warm.p95)} ms is worse than cold p95 ${Math.round(s.cold.p95)} ms`);
  }
  return { pass: reasons.length === 0, reasons };
}

// ---- real run (spends a little money; only when invoked directly) --------------------------------------------------------
async function main(): Promise<void> {
  const imageArn = process.env.MICROVM_IMAGE_ARN;
  if (!imageArn) throw new Error("set MICROVM_IMAGE_ARN (and AWS_PROFILE)");
  const { createAwsMicrovms } = await import("../api/aws-microvms.ts");
  const aws = createAwsMicrovms({ region: process.env.AWS_REGION ?? imageArn.split(":")[3] ?? "us-east-1" });
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const deps: MeasureDeps = { aws, fetch: (url, init) => fetch(url, init), now: Date.now, sleep };

  const shortCycles = Number(process.env.MEASURE_SHORT_CYCLES ?? 20);
  const longCycles = Number(process.env.MEASURE_LONG_CYCLES ?? 5);
  const longDwellMs = Number(process.env.MEASURE_LONG_DWELL_MS ?? 15 * 60_000);
  const staggerMs = Number(process.env.MEASURE_STAGGER_MS ?? 3 * 60_000);

  console.error(`short sample: ${shortCycles} cycles, 10 s dwell, one at a time`);
  const short = await runMeasurement(deps, { imageArn, dwellMs: 10_000, cycles: shortCycles });
  console.log(formatMeasurement(short));

  // Sequential long cycles would take over an hour, so start them staggered: at most `longCycles` VMs alive, resumes spread apart.
  console.error(`long sample: ${longCycles} cycles, ${longDwellMs / 60_000} min dwell, started ${staggerMs / 1000} s apart`);
  const parts = await Promise.all(Array.from({ length: longCycles }, async (_, i) => {
    await sleep(i * staggerMs);
    return runMeasurement(deps, { imageArn, dwellMs: longDwellMs, cycles: 1 });
  }));
  const cycles = parts.flatMap((p) => p.cycles);
  const failures = parts.flatMap((p, i) => p.failures.map((f) => ({ cycle: i + 1, error: f.error })));
  const long: MeasurementResult = {
    dwellMs: longDwellMs, cycles, failures,
    ...(parts.find((p) => p.stoppedEarly) ? { stoppedEarly: parts.find((p) => p.stoppedEarly)!.stoppedEarly } : {}),
    cold: summarizeLatencies(cycles.map((c) => c.coldMs)),
    warm: summarizeLatencies(cycles.map((c) => c.warmMs)),
    suspend: summarizeLatencies(cycles.map((c) => c.suspendMs)),
  };
  console.log(formatMeasurement(long));

  const gate = evaluateWarmGate([short, long]);
  console.log(gate.pass ? "GATE: PASS, build the warm pool" : `GATE: FAIL, skip the pool\n${gate.reasons.map((r) => `  - ${r}`).join("\n")}`);
  const dir = join(import.meta.dirname, "..", "docs", "measurements");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "startup-cold-warm.json"), JSON.stringify({ measuredAt: new Date().toISOString(), imageArn: imageArn.replace(/:\d{12}:/, ":<account-id>:"), short, long, gate }, null, 2) + "\n");
}

if (process.argv[1] && /measure-startup\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(2); });
}
