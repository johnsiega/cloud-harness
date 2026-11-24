# Phase 4 plan: warm start

Status: planned, not started. Written on Opus 5.5 for a Sonnet 5.5 build. Base commit: `a983f00`.

## Goal

The document's gate is a `sandbox_resuming -> sandbox_ready` animation with both startup metrics displayed. Its startup claim also requires cold and warm to be reported separately, with median and p95 on the control-plane clock, and a statement that the readiness metric excludes repo clone and model latency.

The animation and both metrics already exist. What is missing:

1. Real cold and warm measurements.
2. A warm path that real runs can use, but only if the measurements justify it.
3. A correct label. The UI currently says "snapshot resume" on every run, which would read as a warm start.

## What we know

| Fact | Source |
|---|---|
| `suspend-microvm` goes through `SUSPENDING` to `SUSPENDED`; `resume-microvm` requires `SUSPENDED` | AWS CLI help |
| SDK has `SuspendMicrovmCommand`, `ResumeMicrovmCommand`, `GetMicrovmCommand`, `ListMicrovmsCommand` | Checked in `node_modules` |
| `lambda:*Microvm*` covers suspend and resume for `kumpas-harness` | Existing IAM policy; no IAM change or root login needed |
| `maximumDurationInSeconds` includes suspended time; range 1 to 28,800 | AWS docs |
| `SUSPENDED` VMs count against the account memory quota | AWS docs |
| Current runs use a 1,800 s cap and no idle policy | Real VM record |
| Current image enables only the `run` and `ready` hooks | Commit `e0d49df` and earlier |
| Snapshots capture process memory and disk | AWS docs |

Not known until measured: resume latency, whether resume works with the `/resume` hook disabled, whether the endpoint and auth token survive suspend, default quota, and suspended-VM snapshot size.

Pricing is an unverified estimate from a truncated page summary, and may not be the x86 rate. Do not record it as fact. The measurement run is likely under $2.

## Design decisions

1. **Measure before building the pool.** Cold and warm are both snapshot restores and may be close.
2. **Pooled VMs hold no secret.** A pooled VM launches with `runHookPayload: "{}"`. The OpenRouter key and model arrive in the runner POST after resume, so nothing sensitive sits in suspended memory or snapshot storage, and one pooled VM can serve any model.
3. **One VM, one run.** A resumed VM is terminated after its run and never returns to the pool. A pooled VM has never run agent code before it is claimed.
4. **Pool size is one.** A concurrent second run goes cold.
5. **No idle spending.** Refill at boot and after a claim. No recycle timer. A VM too old to use is replaced at the next claim, and that run goes cold.
6. **Explicit lifetime.** Pool VMs use a 14,400 s cap, `suspendedDurationSeconds: 14400`, and `autoResumeEnabled: false`, so stray traffic cannot wake them. A claim requires at least 1,800 s of remaining life.
7. **A warm failure never fails a run.** Terminate the bad VM and fall back to cold inside the same run, and record the path actually taken.
8. **Off by default.** The pool runs only with `WARM_POOL=1`.

## Build sequence

Every code step is tests first, a red run against a stub, then "tests approved" before implementation. Steps marked **[go]** spend money and need a separate go.

### Part A: measure

**Step 1. AWS seam.** Extend `AwsMicrovms` in `api/types.ts` and implement in `api/aws-microvms.ts`:

```ts
suspend(id: string): Promise<void>;
resume(id: string): Promise<void>;
describe(id: string): Promise<{ state: string; endpoint?: string; stateReason?: string }>;
listByImage(imageArn: string): Promise<{ microvmId: string; state: string }[]>;
```

Add optional `idlePolicy` to the run input type in `scripts/smoke-test.ts`.

**Step 2. `scripts/measure-startup.ts`.** Follow the `smoke-test.ts` pattern: pure exports, injected AWS/fetch/clock, `main()` guarded.

```ts
summarizeLatencies(ms: number[]): { n: number; min: number; median: number; p95: number; max: number }
measureCycle(deps, opts): Promise<CycleResult>
```

- p95 uses nearest-rank. Pin that in tests with hand-authored values, including n=1, n=20 and empty input.
- Each cycle uses a fresh VM: launch, ready (cold sample), suspend, wait for `SUSPENDED`, dwell, resume, re-read the endpoint, get a fresh token, ready (warm sample), terminate in `finally`.
- Cold anchor is the `run-microvm` call. Warm anchor is the `resume-microvm` call. Both include auth-token creation and end at the first `/health` 200.
- Poll `/health` every 50 ms for both, so p95 is not poll quantization.
- Measurement VMs use `runHookPayload: "{}"` and never receive the key.
- Stop at the first quota error and report it. Always terminate what was started.
- Write raw results to `docs/measurements/startup-cold-warm.json`.

Tests: percentile values, state waits, timeouts, invalid transitions, terminate on every failure path, endpoint re-read, fresh token, no key in any AWS input.

**Step 3. Real measurement [go].** On image `hq-smoke-1795435760936`:

- 20 cycles with a 10 s dwell.
- 5 cycles with a 15-minute dwell, since a pool VM waits far longer than 10 s.

### Decision gate

Fixed in advance. Build Part B only if **all** hold:

- Warm median is at least 30% and at least 500 ms below cold median, on both dwell samples.
- Warm p95 is no worse than cold p95.
- All 25 resumes succeed.

If not, skip to Step 8 with the cold-only label and record the numbers as the result. That is a valid outcome.

### Part B: warm pool (only if the gate passes)

**Step 4. Runner takes credentials after resume.** In `scripts/runner/server.mjs`, `POST /` accepts optional `key` and `model`, used only when the run hook delivered no key. Redaction must cover a key from either source. Still 412 when neither exists. Rebuild the image.

Tests in `scripts/runner/server.test.ts`: body key works and is redacted, a hook key wins, a bad key or model type gets 400, the script environment stays isolated.

**Step 5. `api/warm-pool.ts`.**

```ts
createWarmPool({ aws, imageArn, region, fetch, now, sleep }) => {
  fill(): Promise<void>;        // single-flight; no-op if a VM is held
  claim(): { microvmId: string; expiresAt: number } | null;  // synchronous, so two runs cannot claim one VM
  reapOrphans(): Promise<number>;
  drain(): Promise<void>;
  status(): "empty" | "filling" | "ready" | "backoff";
}
```

- `fill`: launch, ready, suspend, wait for `SUSPENDED`, then hold.
- Failures back off from 30 s to 10 min. A quota error stops refills until restart and never affects cold runs.
- `reapOrphans` runs at boot and terminates only `SUSPENDED` VMs from `hq-smoke-*` images. `taskkill /F` runs no exit handlers, so this plus the 14,400 s cap is the cleanup path.

**Step 6. Launcher and contract.**

- `launch()` tries `pool.claim()`, then resume, re-read endpoint, fresh token, ready (30 s limit). On any failure: terminate, go cold. After a claim: `void pool.fill()`.
- `SandboxHandle` gains `mode: "cold" | "warm"`. `sandbox_ready` gains `mode`. `RunRecord` gains `startMode`.
- `start()` sends `{ repoUrl, task, key, model }` for warm and stays `{ repoUrl, task }` for cold.
- `api/main.ts` wires the pool behind `WARM_POOL=1`: reap, fill, drain on SIGINT.

Approved tests that change: the `sandbox_ready` deep-equal in `run-controller.test.ts`, and the launcher handle deep-equal. Show those diffs at the gate.

**Step 7. UI.** `run-view.ts` records `startMode`. The rail says "resumed from suspend" or "started from image". Fix the misleading "snapshot resume" label even if the gate fails.

**Step 8. Real verification [go].**

- One warm run through the browser, checking the label, diff and test result.
- 5 end-to-end warm and 5 cold runs for the first-output metric.
- `taskkill /F`, restart, and confirm the orphan is reaped.
- Confirm every VM ends `TERMINATED`.

**Step 9. Docs.** Record numbers in `docs/DECISION_LOG.md` with the required wording: readiness excludes repo clone and model latency, "first output" is the first agent message at about 500 ms poll resolution, and what N was. Tick the startup item in `Development_Process.md` section 10 only if it is met.

## Failure handling

| Failure | Behavior |
|---|---|
| Pool empty or VM too old | Cold run; refill |
| Resume fails, 502, or not ready in 30 s | Terminate VM; same run goes cold; `mode: "cold"` |
| Endpoint changed after suspend | Handled by re-reading it |
| Refill fails | Back off; cold runs unaffected |
| Quota exceeded | Stop refills until restart; report in the log |
| Control plane killed | Reaped at next boot; AWS cap is the backstop |
| Second run during refill | Cold |

## Optional 4c: pre-clone in the pool

A pooled VM could clone the repo and run `composer install` before suspending. Most run time is there, so this is where users would feel the speedup. It needs a two-phase runner, ties the pool to one repo and commit, and needs stale-base handling. It would not change the document's readiness metric. **Recommendation: skip for now** and report it only as a separate end-to-end number if ever built.

## Out of scope

Pools larger than one, reusing a VM for a second run, `kill-all.ts` and the simulation (Phase 5), `VALIDATION.md` (Phase 6).
