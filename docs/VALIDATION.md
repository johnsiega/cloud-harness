# Validation

What was actually measured, with how many samples, when, how, and where the raw data is. Simulated numbers appear only in the section that says "simulated" and never in a table of measured values.

**Setup for every real measurement:** one Windows 11 machine, over the public internet, to AWS `us-east-1`; AWS account on the reduced new-account MicroVM quota (below); default model `deepseek/deepseek-v4.1-flash`; sample sizes are small, so read these as indications, not benchmarks.

## 1. Startup: cold start from the image and resume from suspend (measured)

**Method.** `scripts/measure-startup.ts`, fresh VM per cycle. Cold = `run-microvm` call to first healthy `/health` (includes creating the access token). Warm = `resume-microvm` call to `RUNNING`, then a fresh token, then first healthy `/health`. Same 50 ms probe for both. Measurement VMs got an empty payload (no key). Measured 2026-11-24 with the AWS SDK. Raw data: [`measurements/startup-cold-warm.json`](measurements/startup-cold-warm.json). Write-up: [DECISION_LOG.md](DECISION_LOG.md), "Warm start".

| Sample | N | Cold median / p95 | Warm (resume) median / p95 | Suspend median |
|---|---|---|---|---|
| 10 s suspended, one VM at a time | 20 | 1,926 / 2,321 ms | 1,804 / 1,851 ms | 878 ms |
| 15 min suspended, started 3 min apart | 4 | 1,987 / 2,126 ms | 1,853 / 2,245 ms | 884 ms |

- Cold range in the 20-run sample: 1,256 to 2,400 ms.
- Resume was 122 ms (10 s sample) and 134 ms (15 min sample) faster at the median. The pre-agreed bar for building a warm pool was at least 30% and at least 500 ms on both, so it **failed** and no pool was built.
- With N=4, a p95 is simply the second-largest value, not a stable tail. Both samples ran from one machine. The 15-minute cycles ran with staggered concurrency, a code path with no unit test.
- **"Ready" excludes** cloning the repo and model latency, which dominate a real run. It is the infrastructure readiness metric, not the time to the agent's first output.

## 2. Single real runs (measured)

| What | Value | N | Date | Source |
|---|---|---|---|---|
| Integration test: startup / first agent message / test duration | 1,819 ms / 4,903 ms / 11.6 s | 1 | 2026-11-25 | [`measurements/integration-2026-11-25.json`](measurements/integration-2026-11-25.json) |
| Run in which the VM was killed mid-run | startup 1,865 ms; ended as an error 11 s after the kill (see §5) | 1 | 2026-11-25 | [`measurements/kill-all-check.json`](measurements/kill-all-check.json) |

**"First output" is not "first reasoning token".** Codex's `--json` stream has no reasoning items, so that metric is not available. The figure here is the first agent message, observed at the control plane's 500 ms poll resolution (and 1 s in the load script's own polling), measured from the submit call.

## 3. Real concurrent runs (measured, capped by the account's quota)

**Quota.** Service Quotas, read from the Console on 2026-11-25 (screenshot from the account owner): "Max allocated X86_64 MicroVM memory" is **8 GB applied** against a 2,048 GB AWS default. The limit is memory, not a count, and suspended VMs count. Our runs use the 2 GB baseline, so **four** fit at once. (Other limits on the same page matched the documentation: RunMicrovm 5/s, ResumeMicrovm 5/s, SuspendMicrovm 2/s, TerminateMicrovm 10/s; concurrent image builds were 10.)

**Method.** `scripts/load-real.ts` through the real control plane: K runs submitted together (250 ms apart), each a small "add a one-line comment above `enabled()`" task on `jyvnn/hospital-queue`; all VMs killed and confirmed gone between steps. 2026-11-25. Raw data: [`measurements/load-real.json`](measurements/load-real.json).

| Step K | Runs that succeeded | Notes |
|---|---|---|
| 2 | 2 of 2 | first output 45 to 46 s, total 61 to 63 s (unexplained; not investigated) |
| 3 | 3 of 3 | first output 5.2 to 16.9 s, total 12.4 to 32.8 s |
| 4 | 4 of 4 | first output 4.4 to 6.8 s, total 10.9 to 15.4 s |
| 5 | 4 of 5 | the fifth VM was refused after 1 s: "The base maximum allocated memory limit has been reached for this account." |

- **Highest K that fully succeeded: 4**, one run per step (N=1 per K). Across the 13 successful runs: startup median 1,337 ms (min 1,260, max 2,243); first output median 6.8 s (min 4.4, max 45.7); total median 15.4 s (min 10.6, max 62.9).
- Startup stayed 1.3 to 2.2 s while four VMs started together. Durations vary a lot with model latency, so these totals are not comparable to single-run figures.
- The script labelled the K=5 stop as "a failure other than the quota", because AWS's wording does not contain "quota". It is a quota stop; only the label was wrong. The detection was fixed afterwards in `api/quota.ts` (shared by `load-real` and `measure-startup`, with tests), and the stored record keeps the original label.
- **The document's "real mode tested at 10 to 20 MicroVMs" is not met.** It needs a Service Quotas increase, which only the account owner can request. After an increase, re-run `scripts/load-real.ts` with higher `LOAD_MAX_K` and update this section.

## 4. 100 concurrent runs (simulated, not real)

Nothing in this section was run on MicroVMs. `POST /simulate?n=100` generates seeded events (startup drawn from 1.3 to 2.4 s, run times 15 to 50 s, about 10% failing) and sends them over one SSE connection, each frame tagged `simulated: true`. The UI shows a permanent "Simulated: no MicroVMs are started" banner.

- **Unit tests:** the generator (same seed same plan, all 100 runs alive together in one window, durations in range) and the endpoints (one connection carries all 100 runIds, each with at least one event, exactly 100 `done` events then `simulation_done`, abort stops all timers, nothing real is called).
- **Real browser check, 2026-11-25** (built-in browser pane, viewport emulated at 1440x900, demo mode): 100 tiles rendered, all 100 in progress at once (maximum 100), and all 100 past "ready" together 5.9 s after clicking Start; final state of the second run 88 done and 12 failed (N=1; the number of failures is random per run). A first run measured while the browser pane was hidden had its rendering paused until the pane was shown (the page batches updates per animation frame); only its end state (97 done, 3 failed) was kept. Exactly one `POST /simulate` and one stream request per simulation, no reconnects. Clicking a finished tile opened it in the Reasoning, Terminal and Diff panels. On a second simulation (N=2 runs, 2026-11-25) a real click on **Copy diff** changed the button to "Copied", which the app sets only after the clipboard write succeeds; the copied text was **not** read back (the pane blocks clipboard reads), so its contents are unverified. Data: [`measurements/simulation-browser-check.json`](measurements/simulation-browser-check.json); screenshot: [`measurements/simulation-100-in-progress.jpg`](measurements/simulation-100-in-progress.jpg).
- **Not checked:** browsers other than the built-in one, mobile layout, assistive technology.

## 5. Termination (measured)

`scripts/kill-all.ts`, real AWS, 2026-11-25, [`measurements/kill-all-check.json`](measurements/kill-all-check.json), N=1 each:
- 2 idle VMs started with an empty payload: the dry run listed both and changed nothing; `--yes` gave "Terminated 2, failed 0", exit 0; both were then `TERMINATED`.
- 1 real run killed about 7 s in (agent working): the run ended as an error, `events poll failed: HTTP 502`, 11 s after the kill command started, and its VM was `TERMINATED`. The next poll returned a quick 502 instead of hanging, so the per-request timeout (unit-tested) was **not exercised** against real AWS.
- After every real step of this validation, `list-microvms` showed no VM that was not `TERMINATED`.

## 6. Branch push (measured)

2026-11-23, real GitHub: run `936e253c` pushed to the private `johnsiega/hospital-queue-harness` as one commit by "Cloud harness" with parent `ea724ce`, one file, +1 −0, exactly the diff shown in the UI. `main` was unchanged, no Actions runs started, a repeat push answered 409 and created nothing, and the token appeared in no log or response. N=1 real push. Details: [DECISION_LOG.md](DECISION_LOG.md), "Push mechanics and first real push". Nothing was pushed during the Phase 5 and 6 measurements above.

## 7. Models (measured in Phase 0)

Five real runs each on the same task; "correct" means one comment directly above the right method and nothing else. Run on 2026-11-23. The raw per-run files were **not kept in the repository**, so the table rests on the notes in [DECISION_LOG.md](DECISION_LOG.md), "Model".

| Model | Correct diffs | Median run |
|---|---|---|
| `deepseek/deepseek-v4.1-flash` (default) | 5 of 5 | about 17 s |
| `particle-ai/particle-1` | 5 of 5 | about 16 s |
| `qwen/qwen3-coder` | 4 of 5 | about 20 s |
| `qwen/qwen3-coder-30b-a3b-instruct` | 2 of 5 | about 51 s |

## 8. Tests and CI

- **Unit and local tests:** 525 tests, 524 pass, 1 skipped (the real-AWS integration test, skipped unless `RUN_INTEGRATION=1`), with `npm test` after the per-run test command work (it was 466 after the quota-detection fix, and 459 when the Phase 5 real runs were made). They need no AWS access. CI was green on Ubuntu and Windows for this count (commit `12ce818`).
- **Integration test:** 1 real MicroVM through the real control plane (HTTP to SSE), run on 2026-11-25: passed (status done, 10 events, a 406-byte diff). Record: [`measurements/integration-2026-11-25.json`](measurements/integration-2026-11-25.json).
- **CI:** the tests and the UI build ran green on Ubuntu and Windows for every commit pushed in Phase 5 (GitHub Actions). macOS was not tested.

## 9. Costs

- **Model tokens:** about $0.002 per run on the default model, estimated from token counts in the Phase 0 smoke runs. Not re-measured; the spend on OpenRouter for the Phase 5 runs was **not recorded here**. Check your OpenRouter dashboard.
- **AWS compute:** **not measured.** The pricing figures from AWS pages were not verified, so no per-run AWS cost is claimed.

## 10. Gaps: what was not tested

- Real mode at 10 to 20 MicroVMs (blocked by the 8 GB quota).
- A poll that hangs against real AWS (the per-request timeout is unit-tested only).
- macOS, and Linux or macOS machines running the control plane in real mode (CI runs the unit tests there only).
- The AWS setup steps in the README and the image build on a clean account. They were followed once, on this account.
- Chrome, Firefox and Safari for the UI; the 100-run check used the built-in browser only.
- The unexplained slow first two runs of the K=2 step (about 45 s to first output).
- Per-model results beyond N=5 per model, and any repository other than `jyvnn/hospital-queue`.
- AWS and OpenRouter cost per run.
- **Test command (section 11):** the Node and Python detection paths and the 180 s install limit have not run in a real MicroVM; a custom command and `skip` were never run for real; a repo with pytest or Node tests was not run for real.
- **Slower first output on a freshly built image** (about 29 to 48 s for the first runs, section 11): three follow-up runs got steadily faster (first activity 31.8, 14.2, 6.8 s), which fits a warm-up effect, but the cause was not isolated and the old image was not run to compare. How long an image stays warm when idle was not measured.

## 11. Per-run test command (measured, 2026-11-25)

Real runs of the build with the per-run test command (the runner detects the tests inside the VM). Three real runs in all, one image build, one machine; read them as indications.

- **Image build:** `hq-smoke-1795605632129`, 181.2 s to `CREATED` (service-side time reported by the smoke script). The Dockerfile's `python3 -m pip install pytest` and its check line (python3, pytest, `timeout`) passed on the first build.
- **Smoke run on `jyvnn/hospital-queue`** (the script's default task, run straight through the runner, not the control plane): gate passed, `test_exit_code` 0, 459-byte diff, 43.4 s total, 3.8 s to ready, about 31 s before the agent's first message, 30,251 input and 214 output tokens.
- **Regression through the control plane, `jyvnn/hospital-queue`, Test command blank** (run `dcdced83-129c-4de6-a0cb-7f7ac8d6dfeb`): ended `done`; the test step was **detected as PHP and passed** ("Tests passed", green); the diff was one added comment line above `enabled()` and nothing else. 1.8 s to ready, 47.5 s to first output, 53.8 s total.
- **`johnsiega/goats-hsw-rag-chatbot`, Test command blank** (run `4b3ce2d2-64ea-4ea3-a988-2a65ac168114`): ended `done`; the rail showed the grey **Tests not run: no tests found** and the Terminal badge was grey, not green and not red. The diff was one comment line at the top of `app.py`. 1.3 s to ready, 28.8 s to first output, 35.0 s total. This is the case that used to end in error from a missing `composer.json`. I did not push this run.
- **Slower than before (probably a warm-up effect; see the next bullet):** first output came after 29 to 48 s in all three runs on the new image, against a median of 6.8 s (and 15.4 s total) in the earlier 13 real runs. Ready times were normal (1.3 to 3.8 s), and after the first output the agent, tests and diff took only about 4 to 6 s. The old image was not run on the same day.
- **Follow-up: three more smoke runs back to back on the same new image** (`SMOKE_IMAGE_ARN=<image> SMOKE_RUNS=3 npm run smoke`, hospital-queue, 2026-11-25): total 60.3 s, 28.0 s, 15.0 s; first agent activity at about 31.8 s, 14.2 s, 6.8 s; the test step (Composer install and tests) took about 20 s, 8 s, 4 s; ready 3.7 to 3.8 s each time. Everything after the sandbox came up got faster from run to run, including the test step, which involves no model. That points to a warm-up effect on a freshly created or idle image (the same pattern as the two slow K=2 runs in section 3, which were followed by fast runs), and not to the model service. **This is consistent with that explanation, not proof of it:** it is one image, three runs, one session, the cause was not isolated, and the old image was not run to compare. It was not checked how long an image stays warm after being idle. The three runs cost about $0.006 of model tokens plus a few minutes of one 2 GB MicroVM; the AWS cost was not measured.
- **Not run for real:** the Node and Python detection and install paths, the 180 s install limit against a real slow install, a custom command, `skip`, and the request path for a typed command. These are covered by unit and script tests with fake `npm`, `python3` and pip programs only.
