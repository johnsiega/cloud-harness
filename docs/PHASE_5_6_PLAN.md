# Phase 5 and 6 plan: simulation, load, validation, freeze

Status: planned, not started. Written on Opus 5.5 for a Sonnet 5.5 build. Base commit: `9988f23`.

## What the document requires

| Source | Requirement |
|---|---|
| Section 2, item 7 | `POST /simulate?n=100` drives the UI with synthetic events |
| Section 7 | `simulate-100.test.ts`: all simulated runs stream over **one** SSE connection, every event tagged with `runId`; every runId gets at least one event; the connection does not drop; verify in a real browser that all 100 traces render concurrently |
| Phase 5 gate | 100 synthetic runs render; `kill-all.ts` terminates all real MicroVMs |
| Section 1 claim | "100+ concurrent agents": simulation renders 100; real mode tested at 10 to 20 MicroVMs and disclosed honestly |
| Phase 6 gate | Unit tests pass; integration test passes; `VALIDATION.md` records actual numbers; README discloses simulation vs real |
| Checklist | `README` states data boundaries (repo contents go to OpenRouter; key never logged); decision log records every architectural choice |

## Known constraints

- **Quota.** On the default account limit, a fifth VM was refused while four were suspended. The running ceiling is unknown and may differ. "Real mode at 10 to 20" probably needs a quota increase, which only you can request: in the AWS Console, open Service Quotas and search "Lambda MicroVMs". The `kumpas-harness` user can't, and the root session has expired.
- **Every push is public.** Scan before each push.
- **Two cut-order items are already settled.** The branch push is done, and the warm pool was measured and not built.

## Verified limits (AWS documentation, read 2026-11-25; no AWS call, no cost)

Source: the "Lambda MicroVMs" table in the Lambda quotas page, and "Scaling and concurrency" in the MicroVM launching guide.

| Limit | Documented value |
|---|---|
| Memory across all MicroVMs, per account per Region | **2,048 GB in us-east-1** (800 GB elsewhere). It is **memory, not a VM count**, and covers VMs in `RUNNING` **or `SUSPENDED`**. Adjustable in Service Quotas ("Memory allocated across all MicroVMs"). |
| New accounts | AWS gives **reduced** MicroVM quotas and raises them automatically based on usage |
| `RunMicrovm` | 5 requests/s (burst 5) |
| `ResumeMicrovm` | 5/s |
| `SuspendMicrovm` | **2/s** |
| `TerminateMicrovm` | 10/s |
| `GetMicrovm` | 100/s |
| `CreateMicrovmAuthToken` | 50/s |
| Concurrent image builds | 5 (adjustable) |
| Images per account | 100 |
| Per MicroVM, not adjustable | 8 hours maximum; 40 requests/s on 4 vCPU / 8 GB |

**What this means for us.** The default 2,048 GB would fit hundreds of 2 GB VMs, yet our account refused a fifth VM while four were suspended. So this account is on the **reduced new-account quota**. Our VMs use the 2 GB default baseline, so the applied limit looks to be somewhere between 8 and 10 GB. That is an inference, not a fact: the scoped user cannot read Service Quotas.

**Free ways to learn the real number:**
1. Look in the AWS Console: Service Quotas, AWS services, Lambda MicroVMs, "Memory allocated across all MicroVMs". It shows the applied value and costs nothing. **Ask the user to read it and paste the number.**
2. A user with admin rights could grant `servicequotas:GetServiceQuota` and `servicequotas:ListServiceQuotas`. Not needed if the Console value is known.

**Consequences for the plan:**
- **Concurrency is memory-limited, not count-limited.** A real run needs the 2 GB baseline (Codex, Composer and PHP), so real concurrent runs are capped by the applied quota divided by 2 GB. Expect K of about 4 on this account.
- **A smaller image can show more concurrent isolated sandboxes.** The image API has a `resources` setting with a minimum memory in MiB, down to 512 MiB. A 512 MiB image of **idle VMs with an empty payload (no agent run)** would fit about 4x as many under the same quota. That shows "N isolated sandboxes alive at once", and **must be disclosed as idle sandboxes, not agent runs**. It needs one image rebuild (about 3 minutes, cents). Optional Step 9b.
- **Rate limits matter in the scripts.** `kill-all` must pace terminations at 5 per second at most and retry on `ThrottlingException` with backoff. `load-real` must start runs at least 250 ms apart. `SuspendMicrovm` is only 2/s, which the measurement tool already respected by running cycles one at a time.
- **Raising the quota is free.** The user can request an increase in Service Quotas, and AWS also raises new-account limits automatically with usage. Only then does the document's "real mode at 10 to 20" become reachable.

## Design decisions

1. **Simulated runs never touch real machinery.** No RunStore, no launcher, no push. A simulated "done" run with a diff in the store would be pushable to GitHub. Tests assert that `launch`, `store.create` and `deliver` are never called.
2. **Synthetic is marked in the data, not only the UI.** Every simulation SSE payload carries `simulated: true`, so a screenshot or log can't pass for real runs.
3. **Endpoint shape follows the document.** `POST /simulate?n=100` returns `{ id }`. `GET /simulate/:id/stream` streams every run on one connection and ends with a final `simulation_done` event, so the client closes. Re-requesting a finished or unknown id answers **204**, which stops EventSource's automatic reconnect. Without that, a stateless stream would silently replay all 100 runs.
4. **"Concurrent" is true by construction.** Start jitter and durations are chosen so there is a window where all n runs are between `sandbox_ready` and `done`. A generator test proves the window exists, and the browser check counts in-progress tiles inside it.
5. **Realistic, seeded, and honest.** Durations come from our measured distributions (startup 1.3 to 2.4 s, runs 15 to 50 s), with a small seeded share of failed tests to show error states. Same seed, same output. Content is generic and clearly fictional (`app/Example.php`).
6. **Demo mode.** With no OpenRouter key or image configured, `main.ts` starts in simulation-only mode: `/runs` and push answer 503 with a clear message, and the UI opens on the simulation. Anyone who clones the public repo can see it working with no AWS account.
7. **Real concurrency is stepped, not assumed.** Run K = 2, 3, 4 and up, stop at the first quota error, and record the highest K that fully succeeded.
8. **`kill-all` is dry-run by default.** It terminates only with `--yes`.

## Build sequence

Every code step is tests first, a red run against a stub, then "tests approved" before implementation. **[go]** steps spend money or publish, and need a separate go.

### Phase 5

**Step 1. Simulation generator** (`api/simulation.ts`, pure)

```ts
planSimulation({ n, seed }): SimRun[]   // per run: start offset, startupMs, durations, outcome
simulationEvents(plan): { at: number; runId: string; event: TraceEvent }[]   // time-ordered
```

Tests:
- Same seed gives the same plan, and a different seed gives a different one.
- Every run emits the standard sequence (`sandbox_resuming`, `sandbox_ready`, reasoning, stdout, `test_result`, `diff`, `done`).
- Events are ordered in time.
- There is an all-concurrent window.
- n is bounds-checked (1 to 200).
- Startup values stay inside the measured range.
- The error share matches the seed.

**Step 2. Endpoints.** Write the document's test at `tests/simulation/simulate-100.test.ts` and add the glob to `npm test` so CI runs it.

- `POST /simulate?n=` answers 202 `{ id }`. A bad n gets 400. Only one simulation may be active at a time (409). The request guard applies.
- `GET /simulate/:id/stream` uses one SSE connection, each frame being `formatSse(event, runId)` plus `simulated: true`, and ends with `simulation_done`.
- Scheduling is injected, so CI never waits.

Tests:
- One connection carries all 100 runIds, each with at least one event.
- There are exactly n `done` events, then the terminal event.
- No early close.
- A client abort stops all timers.
- A finished or unknown id answers 204.
- The store, launcher and deliver are never called.
- A cross-origin request is refused.

**Step 3. UI simulation view** (`web/src/simulation-view.ts`, pure, reusing `reduce` from `run-view.ts`)

- `reduceSimulation(state, { runId, event })`, plus `summarizeSimulation(state)` for total, running, done, error and median startup.
- **A grid of 100 compact tiles** showing phase, startup and elapsed time. Clicking a tile opens that run in the existing three panels.
- **A tab:** "Live run" or "Simulation". The simulation tab carries a permanent banner: "Simulated: no MicroVMs are started."
- Updates are batched per animation frame.

Tests: the reducer's routing by runId, isolation between runs, summary counts, and that nothing is mutated.

**Step 4. Demo mode.** `main.ts` starts without a key or image. `/config` reports `{ demo: true }`, and `/runs` and push answer 503 with how to enable them. Tests cover the 503 messages, the `/config` flag and that simulation still works.

**Step 5. Browser check [go: none needed, no AWS].** Run 100 simulated runs in the real browser, record the in-progress tile count inside the all-concurrent window, and take a screenshot for VALIDATION.

**Step 6. Poll timeout hardening.** The launcher's poll `fetch` has no timeout, so a VM killed mid-run could stall that run for a long time. Add a per-request timeout with `AbortSignal.timeout`, as an injected option. Tests cover a hanging poll becoming a run error and the MicroVM still being terminated.

**Step 7. `scripts/kill-all.ts`.** Rename the adapter's `listByImage` to `list(imageArn?)`, since nothing calls it yet.

- Plan the kill: skip `TERMINATED` and `TERMINATING`.
- Dry-run prints the list and the exact command to run with `--yes`.
- `--yes` terminates each VM, continues past per-VM failures, and exits non-zero if any failed.
- Pagination is handled.

Tests: the plan filter, that dry-run never terminates, failure aggregation, and the exit code.

**Step 8. Real `kill-all` check [go].**
1. Start 2 idle VMs with empty payloads (no key).
2. Dry-run, then run with `--yes`, and confirm both are `TERMINATED`.
3. Start one real run, kill it mid-run, and confirm the control plane ends that run as an error, terminates it, and doesn't hang. This verifies Step 6.

**Step 9. `scripts/load-real.ts`.** It starts K real runs through the control plane's HTTP API with distinct tasks, waits for all of them, and reports each run's status, startup, duration and model output.

- K steps up from 2 and stops at the first quota error.
- `kill-all` runs between steps and at the end.

Tests: the summaries and the stop-on-quota logic.

**Step 10. Real load run [go].**
- **Before:** set a spending cap on the OpenRouter key.
- **Cost:** about K × $0.002 per step in model fees, plus VM time.
- **Record:** the highest K that fully succeeded.
- **After:** if you increase the quota, re-run at 10 to 20.

### Phase 6

**Step 11. Integration test [go].** Re-run the real-MicroVM integration test once, as the document requires per phase.

**Step 12. Decision-log audit.** Add entries for choices made but not yet recorded:
- the in-memory store and TTL,
- same-origin UI serving,
- SDK in the control plane but CLI in scripts,
- x86_64,
- the image hook settings,
- the simulation design,
- demo mode,
- the poll timeout.

**Step 13. `docs/VALIDATION.md`.** Every number gets its N, date, method and source file or commit. Simulated numbers never appear in a measured table. It covers:

- **Startup:** cold and warm, with the "readiness excludes clone and model latency" wording.
- **Runs:** end-to-end run times, plus first model output and why it isn't "first reasoning token".
- **Models:** the comparison table.
- **Concurrency:** real (highest K) versus simulated (100), stated plainly.
- **Push:** the verified push.
- **Tests:** test counts and CI on both operating systems.
- **Integration:** the integration test result.
- **Costs:** token costs only, since AWS costs weren't measured.
- **Gaps:** what was not tested (10 to 20 real VMs, macOS, AWS setup steps on a clean account).

**Step 14. README.**
- **New "Data boundaries" section:** the repo's code and the task text go to OpenRouter and the model provider behind it; the sandbox has open internet, so the agent could send code anywhere; the OpenRouter key never appears in logs, the UI or the image (cite the redaction tests); the GitHub token never enters the sandbox.
- **Simulation and demo mode:** how to run them and what they are not.
- **Wording updates:** link VALIDATION, and state that AWS setup and image-build steps are not re-verified on a clean account.

**Step 15. Checklist.** Tick section 10 of `Development_Process.md` only with evidence linked from VALIDATION. Annotate partial items without ticking:
- "first token" is really the first model message.
- "real 10 to 20" is unmet unless the quota is raised.
- "`echo hello`" is satisfied by the stronger full-run evidence.

**Step 16. Freeze [go].** Tag `v1.0.0` and create a GitHub release with honest notes. This is public.

**Step 17. Optional cleanup [go].**
- **Images:** delete the 3 older images (the current policy allows it).
- **S3 zips:** need `s3:DeleteObject`, which the user doesn't have, so either remove them yourself or add the permission.
- **Credentials:** reminders to retire root and to revoke the GitHub token when you're done.

## Open decisions for you

1. **Quota:** request an increase to test 10 to 20 real VMs, or test up to the default ceiling and disclose it. **Recommended: disclose now, raise later if you want.**
2. **Endpoint shape:** `POST /simulate` plus `GET /simulate/:id/stream`, as the document says. **Recommended.**
3. **Demo mode:** so anyone can see the UI with no AWS. **Recommended** for a public resume repo.
4. **Release tag** at the end: yes or no.

## Out of scope

A hosted public demo, authentication, more than one simulation at a time, a pre-cloned pool, and macOS CI.
