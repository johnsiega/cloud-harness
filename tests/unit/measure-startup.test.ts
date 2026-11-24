// Cold vs warm start measurement, tested with a fake AWS and a fake clock: no network, no real waiting, no money.
// Run: node --test tests/unit/measure-startup.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildMeasureInput, evaluateWarmGate, formatMeasurement, measureCycle, runMeasurement, summarizeLatencies, type MeasurementResult, type Stats } from "../../scripts/measure-startup.ts";

const IMAGE = "arn:aws:lambda:us-east-1:111122223333:microvm-image:test";

// ---------------------------------------------------------------------------------------------------
// A fake AWS. Every operation advances the fake clock by a configured cost, so timings are exact.
type Cfg = {
  run?: number; token?: number; suspend?: number; resume?: number;
  coldFails?: number; warmFails?: number; suspending?: number; resuming?: number;
  newEndpoint?: boolean; probeMode?: "503" | "throw";
  neverReady?: boolean; warmNever?: boolean; neverSuspended?: boolean; neverRunning?: boolean; stateOverride?: string;
  fail?: (op: string, vm: number) => Error | undefined;
};

function world(c: Cfg = {}) {
  const k = { run: 40, token: 10, suspend: 20, resume: 30, coldFails: 2, warmFails: 1, suspending: 2, resuming: 0, ...c };
  const w = { t: 0, log: [] as string[], nRun: 0, nTerm: 0, tokens: 0, probes: [] as { url: string; token: string }[], inputs: [] as any[] };
  type Vm = { n: number; phase: "cold" | "suspending" | "suspended" | "resuming" | "warm"; left: number; probes: number };
  const vms = new Map<string, Vm>();
  const vmOf = (id: string) => vms.get(id)!;
  const check = (op: string, id?: string) => { const e = k.fail?.(op, id ? vmOf(id).n : w.nRun); if (e) throw e; };
  const host = (n: number, resumed: boolean) => (resumed && k.newEndpoint ? `vm${n}-resumed.host` : `vm${n}.host`);

  const aws = {
    async run(input: any) {
      w.log.push("run"); w.inputs.push(input);
      const n = ++w.nRun;
      check("run");
      w.t += k.run;
      vms.set(`mvm-${n}`, { n, phase: "cold", left: 0, probes: 0 });
      return { microvmId: `mvm-${n}`, endpoint: host(n, false) };
    },
    async authToken(id: string) { w.log.push("token"); check("token", id); w.t += k.token; return `tok-${++w.tokens}`; },
    async suspend(id: string) { w.log.push("suspend"); check("suspend", id); w.t += k.suspend; const v = vmOf(id); v.phase = "suspending"; v.left = k.suspending; },
    async resume(id: string) { w.log.push("resume"); check("resume", id); w.t += k.resume; const v = vmOf(id); v.phase = "resuming"; v.left = k.resuming; },
    async describe(id: string) {
      w.log.push("describe"); check("describe", id);
      const v = vmOf(id);
      if (k.stateOverride) return { state: k.stateOverride };
      if (v.phase === "suspending") {
        if (k.neverSuspended) return { state: "SUSPENDING" };
        if (v.left > 0) { v.left--; return { state: "SUSPENDING" }; }
        v.phase = "suspended";
        return { state: "SUSPENDED" };
      }
      if (v.phase === "suspended") return { state: "SUSPENDED" };
      if (v.phase === "resuming") {
        if (k.neverRunning) return { state: "SUSPENDED" };
        if (v.left > 0) { v.left--; return { state: "SUSPENDED" }; }
        v.phase = "warm"; v.probes = 0;
        return { state: "RUNNING", endpoint: host(v.n, true) };
      }
      return { state: "RUNNING", endpoint: host(v.n, v.phase === "warm") };
    },
    async terminate(id: string) { w.log.push("terminate"); w.nTerm++; check("terminate", id); },
  };

  const fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    w.log.push("probe");
    w.probes.push({ url, token: init?.headers?.["X-aws-proxy-auth"] ?? "" });
    const v = [...vms.values()].find((x) => url.includes(`vm${x.n}`))!;
    v.probes++;
    const limit = v.phase === "warm" ? k.warmFails : k.coldFails;
    const down = k.neverReady || (v.phase === "warm" && k.warmNever) || v.probes <= limit;
    if (down) { if (k.probeMode === "throw") throw new Error("ECONNRESET"); return { ok: false, status: 503 }; }
    return { ok: true, status: 200 };
  };

  const deps = { aws, fetch, now: () => w.t, sleep: async (ms: number) => { w.log.push(`sleep ${ms}`); w.t += ms; } };
  return { w, deps };
}

const OPTS = { imageArn: IMAGE, dwellMs: 10_000, healthPollMs: 50, statePollMs: 100, timeoutMs: 60_000 };

// ====================================================================================================
describe("summarizeLatencies", () => {
  test("empty input gives all zeros, never NaN", () => {
    assert.deepEqual(summarizeLatencies([]), { n: 0, min: 0, median: 0, p95: 0, max: 0 });
  });

  test("a single sample is its own min, median, p95 and max", () => {
    assert.deepEqual(summarizeLatencies([1234]), { n: 1, min: 1234, median: 1234, p95: 1234, max: 1234 });
  });

  test("the median of an even count is the mean of the middle two, and input order does not matter", () => {
    const s = summarizeLatencies([400, 100, 300, 200]);
    assert.equal(s.median, 250);
    assert.deepEqual([s.n, s.min, s.max], [4, 100, 400]);
  });

  test("p95 uses the nearest-rank method: ceil(0.95 n)-th smallest", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 100); // 100..2000
    assert.equal(summarizeLatencies(twenty).p95, 1900, "n=20 -> rank 19");
    const ten = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);
    assert.equal(summarizeLatencies(ten).p95, 1000, "n=10 -> rank 10, i.e. the maximum");
    const five = [10, 20, 30, 40, 50];
    assert.equal(summarizeLatencies(five).p95, 50, "n=5 -> rank 5");
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(summarizeLatencies(hundred).p95, 95, "n=100 -> rank 95");
  });

  test("it does not mutate the caller's array", () => {
    const input = [3, 1, 2];
    assert.equal(summarizeLatencies(input).median, 2, "it must really compute");
    assert.deepEqual(input, [3, 1, 2]);
  });
});

// ====================================================================================================
describe("buildMeasureInput", () => {
  test("targets the image, sends an EMPTY run hook payload and no secret of any kind", () => {
    const i = buildMeasureInput(IMAGE, 10_000);
    assert.equal(i.imageIdentifier, IMAGE);
    assert.equal(i.runHookPayload, "{}");
    assert.ok(!/sk-or|OPENROUTER|github_pat|token|secret/i.test(JSON.stringify(i)));
    assert.ok(!("environmentVariables" in i));
  });

  test("attaches ingress and internet egress connectors", () => {
    const i = buildMeasureInput(IMAGE, 10_000);
    assert.ok(i.ingressNetworkConnectors && i.egressNetworkConnectors, "connectors must be set");
    assert.equal(i.ingressNetworkConnectors.length, 1);
    assert.match(i.ingressNetworkConnectors[0], /HTTP_INGRESS$/);
    assert.equal(i.egressNetworkConnectors.length, 1);
    assert.match(i.egressNetworkConnectors[0], /INTERNET_EGRESS$/);
  });

  test("auto-resume is off, so a stray request can never wake a VM and corrupt a warm sample", () => {
    const policy = buildMeasureInput(IMAGE, 10_000).idlePolicy;
    assert.ok(policy, "idlePolicy must be set");
    assert.equal(policy.autoResumeEnabled, false);
  });

  test("the lifetime cap covers the dwell plus 15 minutes, at least 1800 s and never above 28800 s", () => {
    assert.equal(buildMeasureInput(IMAGE, 10_000).maximumDurationInSeconds, 1800);
    assert.equal(buildMeasureInput(IMAGE, 3_600_000).maximumDurationInSeconds, 4500);
    assert.equal(buildMeasureInput(IMAGE, 30_000_000).maximumDurationInSeconds, 28800);
  });

  test("suspendedDurationSeconds is at least 3600 and outlasts the dwell by 10 minutes", () => {
    assert.ok(buildMeasureInput(IMAGE, 10_000).idlePolicy, "idlePolicy must be set");
    assert.equal(buildMeasureInput(IMAGE, 10_000).idlePolicy.suspendedDurationSeconds, 3600);
    assert.equal(buildMeasureInput(IMAGE, 3_600_000).idlePolicy.suspendedDurationSeconds, 4200);
    assert.equal(buildMeasureInput(IMAGE, 10_000).idlePolicy.maxIdleDurationSeconds, 3600);
  });
});

// ====================================================================================================
describe("measureCycle timings", () => {
  test("cold = run call to first healthy /health, and includes the auth-token call (40 + 10 + 2 failed probes x 50)", async () => {
    const { deps } = world();
    assert.equal((await measureCycle(deps, OPTS)).coldMs, 150);
  });

  test("suspend = suspend call to SUSPENDED (20 + 2 SUSPENDING polls x 100)", async () => {
    const { deps } = world();
    assert.equal((await measureCycle(deps, OPTS)).suspendMs, 220);
  });

  test("warm = resume call to first healthy /health, including the wait for RUNNING and a fresh token (30 + 1 x 100 + 10 + 1 x 50)", async () => {
    const { deps } = world({ resuming: 1 });
    assert.equal((await measureCycle(deps, OPTS)).warmMs, 190);
  });

  test("the dwell is never counted in any of the three timings", async () => {
    const short = await measureCycle(world().deps, { ...OPTS, dwellMs: 1_000 });
    const long = await measureCycle(world().deps, { ...OPTS, dwellMs: 900_000 });
    assert.equal(short.coldMs, 150, "it must really measure");
    assert.deepEqual(short, long);
  });

  test("the health poll defaults to 50 ms, so p95 is not just poll quantization", async () => {
    const { deps, w } = world();
    const { healthPollMs: _h, ...noPoll } = OPTS;
    await measureCycle(deps, noPoll);
    assert.ok(w.log.includes("sleep 50"));
  });

  test("a probe that throws counts as not ready yet, exactly like a 503", async () => {
    const a = await measureCycle(world({ probeMode: "throw" }).deps, OPTS);
    const b = await measureCycle(world({ probeMode: "503" }).deps, OPTS);
    assert.equal(a.coldMs, 150, "it must really measure");
    assert.deepEqual(a, b);
  });
});

describe("measureCycle sequence and identity", () => {
  test("runs exactly: launch, token, cold probes, suspend, wait, dwell, resume, re-read, fresh token, warm probes, terminate", async () => {
    const { deps, w } = world({ suspending: 1 });
    await measureCycle(deps, OPTS);
    assert.deepEqual(w.log, [
      "run", "token", "probe", "sleep 50", "probe", "sleep 50", "probe",
      "suspend", "describe", "sleep 100", "describe",
      "sleep 10000",
      "resume", "describe", "token", "probe", "sleep 50", "probe",
      "terminate",
    ]);
  });

  test("the warm probes use a FRESH token, not the one from before the suspend", async () => {
    const { deps, w } = world();
    await measureCycle(deps, OPTS);
    const cold = w.probes.filter((p) => p.token === "tok-1");
    const warm = w.probes.filter((p) => p.token === "tok-2");
    assert.equal(cold.length, 3);
    assert.equal(warm.length, 2);
  });

  test("probes go to https://<endpoint>/health with the proxy auth and port headers", async () => {
    const { deps, w } = world();
    await measureCycle(deps, OPTS);
    assert.ok(w.probes.length > 0, "at least one probe must be made");
    assert.equal(w.probes[0].url, "https://vm1.host/health");
  });

  test("the endpoint is re-read after resume: probes follow a changed endpoint and the change is reported", async () => {
    const { deps, w } = world({ newEndpoint: true });
    const r = await measureCycle(deps, OPTS);
    assert.equal(r.endpointChanged, true);
    assert.ok(w.probes.length > 0, "probes must be made");
    assert.equal(w.probes.at(-1)!.url, "https://vm1-resumed.host/health");
    const same = await measureCycle(world().deps, OPTS);
    assert.equal(same.endpointChanged, false);
  });

  test("the launch input is the measurement input: no secret, empty payload", async () => {
    const { deps, w } = world();
    await measureCycle(deps, OPTS);
    assert.equal(w.inputs.length, 1);
    assert.equal(w.inputs[0].runHookPayload, "{}");
    assert.equal(w.inputs[0].imageIdentifier, IMAGE);
  });
});

describe("measureCycle failures always clean up", () => {
  const cases: [string, Cfg, RegExp][] = [
    ["token", { fail: (op) => (op === "token" ? new Error("token failed") : undefined) }, /token failed/],
    ["suspend", { fail: (op) => (op === "suspend" ? new Error("suspend failed") : undefined) }, /suspend failed/],
    ["resume", { fail: (op) => (op === "resume" ? new Error("resume failed") : undefined) }, /resume failed/],
    ["describe", { fail: (op) => (op === "describe" ? new Error("describe failed") : undefined) }, /describe failed/],
    ["never ready (cold)", { neverReady: true }, /not ready/i],
    ["never ready (warm)", { coldFails: 0, warmNever: true }, /not ready/i],
    ["never suspended", { neverSuspended: true }, /suspend.*timed out/i],
    ["never running again", { neverRunning: true }, /resume.*timed out/i],
    ["unexpected state", { stateOverride: "TERMINATED" }, /unexpected state TERMINATED/],
  ];

  for (const [name, cfg, message] of cases) {
    test(`${name}: rejects with a clear error and terminates the VM exactly once`, async () => {
      const { deps, w } = world(cfg);
      await assert.rejects(measureCycle(deps, { ...OPTS, timeoutMs: 1_000 }), message);
      assert.equal(w.nTerm, 1);
      assert.equal(w.log.at(-1), "terminate");
    });
  }

  test("a failing launch has nothing to terminate", async () => {
    const { deps, w } = world({ fail: (op) => (op === "run" ? new Error("AccessDenied") : undefined) });
    await assert.rejects(measureCycle(deps, OPTS), /AccessDenied/);
    assert.equal(w.nTerm, 0);
  });

  test("a failing terminate never hides the real result or the real error", async () => {
    const ok = world({ fail: (op) => (op === "terminate" ? new Error("already gone") : undefined) });
    assert.equal((await measureCycle(ok.deps, OPTS)).coldMs, 150);
    const bad = world({ neverReady: true, fail: (op) => (op === "terminate" ? new Error("already gone") : undefined) });
    await assert.rejects(measureCycle(bad.deps, { ...OPTS, timeoutMs: 1_000 }), /not ready/i);
  });
});

// ====================================================================================================
describe("runMeasurement", () => {
  test("runs the requested number of cycles on fresh VMs, one after another, and summarizes each metric", async () => {
    const { deps, w } = world();
    const r = await runMeasurement(deps, { ...OPTS, cycles: 3 });
    assert.equal(r.cycles.length, 3);
    assert.equal(w.nRun, 3);
    assert.equal(w.nTerm, 3, "every VM started was terminated");
    assert.deepEqual(r.cold, { n: 3, min: 150, median: 150, p95: 150, max: 150 });
    assert.deepEqual(r.suspend, { n: 3, min: 220, median: 220, p95: 220, max: 220 });
    assert.equal(r.warm.n, 3);
    assert.equal(r.dwellMs, 10_000);
    assert.deepEqual(r.failures, []);
    assert.equal(r.stoppedEarly, undefined);
  });

  test("a failed cycle is recorded with its 1-based number, the rest continue, and stats cover only the successes", async () => {
    const { deps, w } = world({ fail: (op, vm) => (op === "suspend" && vm === 2 ? new Error("suspend failed") : undefined) });
    const r = await runMeasurement(deps, { ...OPTS, cycles: 3 });
    assert.equal(r.cycles.length, 2);
    assert.deepEqual(r.failures, [{ cycle: 2, error: "suspend failed" }]);
    assert.equal(r.cold.n, 2);
    assert.equal(w.nRun, 3);
    assert.equal(w.nTerm, 3);
  });

  test("a quota error stops the whole measurement at once and says why, without starting another VM", async () => {
    const quota = Object.assign(new Error("memory quota reached"), { name: "ServiceQuotaExceededException" });
    const { deps, w } = world({ fail: (op, vm) => (op === "run" && vm === 2 ? quota : undefined) });
    const r = await runMeasurement(deps, { ...OPTS, cycles: 5 });
    assert.equal(w.nRun, 2);
    assert.match(r.stoppedEarly ?? "", /quota/i);
    assert.equal(r.cycles.length, 1);
    assert.equal(r.failures.length, 1);
  });

  test("zero cycles does nothing and returns empty statistics", async () => {
    const { deps, w } = world();
    const r = await runMeasurement(deps, { ...OPTS, cycles: 0 });
    assert.deepEqual(w.log, []);
    assert.deepEqual(r.cold, { n: 0, min: 0, median: 0, p95: 0, max: 0 });
  });
});

// ====================================================================================================
const st = (median: number, p95 = median, n = 20): Stats => ({ n, min: median, median, p95, max: p95 });
const set = (cold: Stats, warm: Stats, o: { failures?: number; cycles?: number; dwellMs?: number } = {}): MeasurementResult => ({
  dwellMs: o.dwellMs ?? 10_000,
  cycles: Array.from({ length: o.cycles ?? 20 }, () => ({ coldMs: cold.median, suspendMs: 1, warmMs: warm.median, endpointChanged: false })),
  failures: Array.from({ length: o.failures ?? 0 }, (_, i) => ({ cycle: i + 1, error: "x" })),
  cold, warm, suspend: st(1),
});

describe("evaluateWarmGate", () => {
  test("passes when both dwell samples are at least 30% and 500 ms faster warm, p95 is no worse, and nothing failed", () => {
    const g = evaluateWarmGate([set(st(3000, 4000), st(1500, 3000)), set(st(3000, 4000, 5), st(1800, 3500, 5), { dwellMs: 900_000, cycles: 5 })]);
    assert.deepEqual(g, { pass: true, reasons: [] });
  });

  test("exactly 30% and exactly 500 ms faster still passes (the thresholds are inclusive)", () => {
    const g = evaluateWarmGate([set(st(2000, 3000), st(1400, 3000)), set(st(2000, 3000), st(1400, 3000))]);
    assert.equal(g.pass, true, JSON.stringify(g.reasons));
    assert.equal(evaluateWarmGate([set(st(1700, 3000), st(1190, 3000)), set(st(1700, 3000), st(1190, 3000))]).pass, true, "30% = 510 ms");
  });

  test("fails when warm is under 30% faster, even if it is over 500 ms faster", () => {
    const g = evaluateWarmGate([set(st(5000), st(4000)), set(st(5000), st(4000))]);
    assert.equal(g.pass, false);
    assert.match(g.reasons.join(" "), /30%/);
  });

  test("fails when warm is under 500 ms faster, even if it is over 30% faster", () => {
    const g = evaluateWarmGate([set(st(1000), st(600)), set(st(1000), st(600))]);
    assert.equal(g.pass, false);
    assert.match(g.reasons.join(" "), /500 ?ms/);
  });

  test("fails when warm p95 is worse than cold p95, naming the dwell sample", () => {
    const g = evaluateWarmGate([set(st(3000, 3500), st(1500, 3600)), set(st(3000, 4000), st(1500, 3000), { dwellMs: 900_000 })]);
    assert.equal(g.pass, false);
    assert.match(g.reasons.join(" "), /p95/);
    assert.match(g.reasons.join(" "), /10 ?s/, "the first (10 s) sample is the one that failed");
  });

  test("fails when any resume failed, or a sample stopped early", () => {
    const failed = evaluateWarmGate([set(st(3000), st(1000), { failures: 1 }), set(st(3000), st(1000))]);
    assert.equal(failed.pass, false);
    assert.match(failed.reasons.join(" "), /fail/i);
    const stopped = { ...set(st(3000), st(1000)), stoppedEarly: "quota" };
    assert.equal(evaluateWarmGate([stopped, set(st(3000), st(1000))]).pass, false);
  });

  test("fails when a sample has no successful cycles at all", () => {
    const empty = set(st(0, 0, 0), st(0, 0, 0), { cycles: 0 });
    assert.equal(evaluateWarmGate([empty, set(st(3000), st(1000))]).pass, false);
  });

  test("needs BOTH dwell samples: one set, or none, cannot pass", () => {
    assert.equal(evaluateWarmGate([set(st(3000), st(1000))]).pass, false);
    assert.match(evaluateWarmGate([]).reasons.join(" "), /both|two|sample/i);
    assert.equal(evaluateWarmGate([]).pass, false);
  });

  test("reports every reason, not just the first", () => {
    const g = evaluateWarmGate([set(st(1000, 1000), st(900, 2000), { failures: 2 }), set(st(1000, 1000), st(900, 2000))]);
    assert.ok(g.reasons.length >= 3, JSON.stringify(g.reasons));
  });
});

// ====================================================================================================
describe("formatMeasurement", () => {
  const r: MeasurementResult = {
    dwellMs: 10_000,
    cycles: [{ coldMs: 1200, suspendMs: 2000, warmMs: 400, endpointChanged: false }, { coldMs: 1800, suspendMs: 2200, warmMs: 500, endpointChanged: false }],
    failures: [{ cycle: 2, error: "suspend failed" }],
    cold: { n: 2, min: 1200, median: 1500, p95: 1800, max: 1800 },
    warm: { n: 2, min: 400, median: 450, p95: 500, max: 500 },
    suspend: { n: 2, min: 2000, median: 2100, p95: 2200, max: 2200 },
  };
  const NOTE = "note: readiness is the submit (cold) or resume (warm) call to the first healthy /health response; it excludes repo clone and model latency";

  test("prints labelled lines for the dwell, cycle counts, all three statistics, each failure and the exclusion note", () => {
    assert.deepEqual(formatMeasurement(r).trim().split("\n"), [
      "dwell_seconds: 10",
      "cycles_ok: 2 of 3",
      "cold_ms: n=2 min=1200 median=1500 p95=1800 max=1800",
      "warm_ms: n=2 min=400 median=450 p95=500 max=500",
      "suspend_ms: n=2 min=2000 median=2100 p95=2200 max=2200",
      "failure cycle 2: suspend failed",
      NOTE,
    ]);
  });

  test("shows why it stopped when it stopped early, and no failure lines when there were none", () => {
    const lines = formatMeasurement({ ...r, failures: [], stoppedEarly: "memory quota reached" }).trim().split("\n");
    assert.ok(lines.includes("stopped_early: memory quota reached"));
    assert.ok(lines.includes("cycles_ok: 2 of 2"));
    assert.ok(!lines.some((l) => l.startsWith("failure cycle")));
    assert.equal(lines.at(-1), NOTE);
  });
});
