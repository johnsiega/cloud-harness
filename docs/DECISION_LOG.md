# Decision log

Each entry records a choice, the evidence behind it, and what it costs. Dates are 2026-11.

## Event transport: HTTP polling of the in-VM runner (Phase 0)
- **Decision:** the runner (`scripts/runner/server.mjs`) buffers JSONL events; the control plane polls `GET /events?since=N` every 500 ms through the MicroVM endpoint.
- **Why:** Lambda MicroVMs have no stdout, exit-code or output-fetch API. CloudWatch Logs would add subscription lag and a second moving part. Measured: submit to sandbox ready 1.3 to 4.5 s over 40+ real runs.
- **Cost:** about 500 ms event granularity, so "first model output" is a polled time, not a streamed one.

## OpenRouter key delivery: run hook payload (Phase 0)
- **Decision:** the key travels only in `runHookPayload` (max 16 KB). The image must enable the run hook (`--hooks` with port 8080, run and ready ENABLED), or `/run` never fires.
- **Why:** MicroVM environment variables are set at image build and shared by every VM from that image, which would bake the key into the snapshot.
- **Evidence:** unit tests assert the key appears only in that payload and never in a URL, header or runner POST body; redaction tests cover the stored record and SSE bytes.

## Wire API: Codex `responses` (Phase 0)
- **Decision:** `wire_api="responses"` against OpenRouter.
- **Why:** Codex 0.171 rejects `wire_api="chat"`. Tool calling through OpenRouter's Responses API was verified for all four candidate models.

## Model: `deepseek/deepseek-v4.1-flash` (Phase 0)
- **Decision:** default model, replacing `qwen/qwen3-coder-30b-a3b-instruct`.
- **Evidence (5 real runs each, strict "one comment directly above enabled()" check):** deepseek-v4.1-flash 5/5 correct, particle-1 5/5, qwen3-coder 4/5, qwen3-coder-30b 2/5 (two empty diffs, one misplaced comment). deepseek used about a fifth of the input tokens of the 30B model.
- **Cost:** the "first reasoning token" metric is unavailable because Codex's `--json` stream emits no reasoning items; the UI reports first model output instead.

## Duplicate submits: rejected only while active (Phase 2)
- **Decision:** a second `POST /runs` with the same `repoUrl` and `task` is rejected (409) while the first is pending or running, and allowed once it finishes.
- **Why:** demos need to rerun the same task; the document's wording does not say whether finished runs count.

## Run outcome rule (Phase 2)
- A run is `error` if the tests exit non-zero, Codex exits non-zero, or the diff is empty or missing. `done.exitCode` is the test exit code if non-zero, otherwise 1 for any other failure.

## Push target: a dedicated private repo (Phase 3)
- **Decision:** branches go to `johnsiega/hospital-queue-harness`, seeded from `jyvnn/hospital-queue`, replacing an earlier candidate repo.
- **Why:** The earlier candidate was an unrelated repo that does not contain the patched files. A dedicated repo also lets the PAT be scoped to one repo, so a leaked token cannot touch the portfolio.
- **Mechanism:** the MicroVM is gone by push time and the token must never enter it, so the control plane applies the captured diff to a fresh full clone at the run's base commit and pushes `harness/<runId>` without force.

## Push mechanics and first real push (Phase 3)
- **Cross-site protection first.** Binding to 127.0.0.1 did not stop a cross-origin `text/plain` POST from starting a MicroVM (202). Every route now needs a loopback Host, a matching Origin, and JSON on POST, before a write token was ever configured.
- **Exact base.** The runner emits `base_commit` right after the clone; the push clones the source with `--revision <base>` so the new commit's parent is the base even when `main` has moved on, and applies `git diff --cached --binary` to the index only (no line-ending conversion, binary-safe).
- **Token handling.** The token travels only in `GIT_CONFIG_*` env on the two git calls that talk to the target (scoped to github.com), never in argv, a URL or a log; global and system git config, credential helpers and every protocol except https are disabled. One push per run, never forced, branch name is server-chosen (`harness/<runId>`).
- **Evidence (2026-11-23, real GitHub):** run 936e253c pushed to `johnsiega/hospital-queue-harness`: one commit "Cloud harness run 936e253c-…", author "Cloud harness", parent `ea724ce`, one file, +1 -0, exactly the diff shown in the UI; `main` unchanged at `ea724ce`; 0 Actions runs; the portfolio repo untouched; a repeat push answered 409 and created nothing; the token appeared in no log or response.
- **Token scope check.** A fine-grained token limited to one repo lists 16 public repos but only one of the account's 7 private repos. Its Contents-write permission cannot be read from the API, so the first push is what proved it.

## Warm start: measured, no warm pool (Phase 4)
- **Decision:** do not build the pre-warmed (suspended) MicroVM pool. Every run starts from the image.
- **Method.** `scripts/measure-startup.ts` on fresh VMs, one cycle each: launch, wait for the first healthy `/health` (cold), suspend, wait, resume, wait for `RUNNING`, fresh token, first healthy `/health` (warm). Same 50 ms probe for both. Cold is measured from the `run-microvm` call and includes creating the access token; warm from the `resume-microvm` call and includes the wait for `RUNNING` and a fresh token. Measurement VMs got an empty payload (no key). Measured from a Windows machine over the public internet to `us-east-1`, with the SDK, on 2026-11-24.
- **Results.**

| Sample | n | Cold median / p95 | Warm median / p95 | Suspend median |
|---|---|---|---|---|
| 10 s suspended, one at a time | 20 | 1,926 / 2,321 ms | 1,804 / 1,851 ms | 878 ms |
| 15 min suspended, started 3 min apart | 4 | 1,987 / 2,126 ms | 1,853 / 2,245 ms | 884 ms |

- **Reading it.** Resume costs about 1.8 s no matter what, with a very tight spread (the 10 s sample's p95 is 1.85 s, with one 2.3 s outlier). A cold start from the image ranges from 1.3 to 2.4 s and is often faster. Warm was 122 ms faster at the median in the 10 s sample and 134 ms in the 15 min sample, against a pre-agreed bar of at least 30% and at least 500 ms on both samples. The gate failed on both, so the pool is not worth its cost, complexity and the key-in-memory risk.
- **Caveats.** The 15-minute sample has n=4, because the fifth VM could not launch (below), and a p95 over 4 or 20 samples is the second-largest or largest value, not a stable tail. Both samples ran from one machine. The long cycles ran with staggered concurrency, a code path with no unit test. "Ready" excludes repo clone and model latency, which dominate a real run.
- **Facts learned.** Resume works with the image's `/resume` hook disabled. The endpoint URL stayed the same across every suspend (24 of 24). The default account memory limit was hit when a fifth VM launched while four were suspended, so suspended VMs count against the quota, as the docs say. That limit also means a real 100-VM run is not possible on a default account.
- **Not measured.** Cost of suspended VMs and snapshots (pricing figures from AWS pages were unverified), and a pre-cloned pool, which would help end-to-end time and not this metric.
- **Raw data:** `docs/measurements/startup-cold-warm.json`.

## Control-plane Node version (Phase 2)
- The document specifies Node 24; development ran on Node 22.18 (native TypeScript type stripping, Hono 4). `engines` is `>=22.18`.

## In-memory run store with a one-hour TTL (Phase 2)
- **Decision:** runs live in a `Map` in the control plane. Records older than one hour are swept every minute.
- **Why:** the specification asks for no database, and a run only needs to outlive its stream and a copy-diff or push click.
- **Cost:** a restart loses every run, including one in progress. Its MicroVM is not terminated by the restart; AWS's own per-VM maximum duration is the backstop, and `scripts/kill-all.ts` is the manual one.

## UI served from the control plane, same origin (Phase 2)
- **Decision:** `npm run web:build` writes `dist/web`, and the Hono server serves it next to the API on `127.0.0.1:3000`, registered after the API routes.
- **Why:** one origin means no CORS configuration at all, which lets the request guard refuse every cross-origin request outright (see the Phase 3 entry).
- **Cost:** after a UI change you rebuild before `npm start`; `npm run web:dev` is available for UI work only.

## AWS SDK in the control plane, AWS CLI in scripts (Phase 0 and 2)
- **Decision:** `api/aws-microvms.ts` uses `@aws-sdk/client-lambda-microvms`. The image build in `scripts/smoke-test.ts` shells out to the AWS CLI.
- **Why:** the image build runs once per image change and the CLI accepted the request shapes first; the control plane needs typed calls, injected clients and no subprocess per run.
- **Cost:** two AWS code paths to keep in step, and the README's setup needs the CLI as well as the SDK.

## x86_64 images (Phase 0)
- **Decision:** the image is built for `X86_64` (`cpuConfigurations` in `scripts/smoke-test.ts`).
- **Evidence and gap:** every measurement in this repo is on X86_64. The reason for choosing it over `ARM_64` was not written down at the time, so none is claimed here. The two architectures have separate memory quotas, both 8 GB on this account (Service Quotas, 2026-11-25).

## Image hook settings (Phase 0 and 4)
- **Decision:** the image enables the **run** hook and the **ready** hook on port 8080, and leaves the **resume** hook off.
- **Why:** with no run hook, the runner never receives its payload and `/run` never fires (found the hard way in Phase 0). The Phase 4 measurement showed resume works with the resume hook disabled, so nothing needs it.
- **Cost:** none known. If a future feature needs code to run on resume, the image must be rebuilt.

## Simulation: seeded, one SSE connection, never real (Phase 5)
- **Decision:** `POST /simulate?n=` (1 to 200) returns an id; `GET /simulate/:id/stream` sends every run's events over **one** SSE connection, each frame tagged with its `runId` and `simulated: true`, then a `simulation_done` event. One simulation at a time (409). A finished, expired or unknown id answers 204, which stops the browser's automatic reconnect.
- **Why:** a real run of 100 MicroVMs is impossible on this account (8 GB memory quota, so 4 concurrent runs; see the Phase 5 measurement below), and the document asks for a UI test at 100. Simulated runs touch no store, launcher or push, so a simulated "done" run cannot be pushed to GitHub. Starts are jittered over 3 s and runs last 15 to 50 s, so there is a window where all 100 are alive together, and a generator test proves it. Startup draws from the measured 1.3 to 2.4 s range; about 10% of runs fail so the error states show.
- **Cost:** the content is generic and fictional, so it shows the UI at scale and says nothing about real agent behaviour. A tab banner and the `simulated` flag in the data say so.

## Demo mode (Phase 5)
- **Decision:** with no `OPENROUTER_API_KEY` or `MICROVM_IMAGE_ARN`, or with `HARNESS_DEMO=1`, the control plane starts without any AWS client. `POST /runs` and push answer 503 with how to enable them, `/config` reports `demo: true`, and the UI opens on the Simulation tab.
- **Why:** anyone who clones the public repo can see it working with no AWS account, and `HARNESS_DEMO=1` lets the owner run the demo with real keys present without any chance of a real run.
- **Cost:** two start-up paths in `api/main.ts`. The 503 behaviour is unit-tested; the start-up wiring was checked by hand (the server started and answered).

## Per-request timeout on every runner call (Phase 5)
- **Decision:** health, start and poll requests to the in-VM runner each get a deadline (30 s by default) through `AbortSignal.timeout`.
- **Why:** without it a fetch to a dead MicroVM can hang, leaving the run stuck until the 20-minute poll budget ends.
- **Evidence and gap:** unit tests cover a hanging poll, start and health probe. On real AWS a run killed mid-run failed fast with an HTTP 502 on the next poll, so **the timeout itself has not been exercised against real AWS**.

## kill-all: dry run by default (Phase 5)
- **Decision:** `scripts/kill-all.ts` lists what it would terminate and changes nothing unless `--yes` is given. Terminations are 200 ms apart (the limit is 10 per second), throttling is retried with backoff, one failure does not stop the rest, and any failure gives a non-zero exit.
- **Evidence (real AWS, 2026-11-25, `docs/measurements/kill-all-check.json`):** 2 idle VMs were listed, then terminated (both `TERMINATED`, exit 0). One real run killed mid-run ended as an error and its VM was `TERMINATED`.

## Real concurrency: stepped, and capped by the memory quota (Phase 5)
- **Decision:** `scripts/load-real.ts` starts K real runs together for K = 2, 3, 4, 5, kills all VMs and waits until they are gone between steps, and stops at the first step that is not fully successful.
- **Why:** the MicroVM limit is memory, not a count, and **suspended VMs count too**. On this account "Max allocated X86_64 MicroVM memory" is 8 GB applied against a 2,048 GB default, so four 2 GB VMs fit. Waiting for `TERMINATED` between steps stops VMs that are still terminating from faking a quota failure.
- **Result (`docs/measurements/load-real.json`):** K = 2, 3 and 4 fully succeeded and the fifth VM at K = 5 was refused (see VALIDATION.md). The highest K that fully succeeded was 4.
- **Flaw found and fixed:** the refusal text ("The base maximum allocated memory limit has been reached for this account.") does not contain the word "quota", so the report labelled that stop a plain failure. The numbers were right and the label was wrong. Detection now lives in `api/quota.ts` and matches both wordings; `load-real` and `measure-startup` share it. `docs/measurements/load-real.json` is raw data and keeps the original label.

## Per-run test command: detected inside the VM (2026-11-25)
- **Decision:** the test step is no longer hardcoded to `composer install && php artisan test`. The form takes an optional **Test command**: blank auto-detects, `skip` skips, anything else (at most 500 characters) is run as given. Detection (`scripts/runner/detect-tests.mjs`) runs inside the VM, because the repo only exists there. First match wins: PHP, then Node, then Python, otherwise "no tests found". For a Laravel repo the command is byte-for-byte the old one.
- **Why:** on any non-PHP repo the old command failed ("Composer could not find a composer.json"), so a good edit ended in error and could not be pushed. A repo with no tests could never end done.
- **Outcome:** "tests not run" is reported as exit 0 with a `skipped` reason, so the run ends done and the diff stays pushable. The UI shows it as a grey **Tests not run** with the reason, never green. The outcome rule for real failures is unchanged.
- **Decisions beyond the spec (approved 2026-11-25):**
  - **pytest is baked into the image.** Without it, a Python repo that does not list pytest in `requirements.txt` would fail with "No module named pytest" and end in error through no fault of the agent. Baking it in costs a few MB once at build time and adds no time to a run, and it leaves the 180 s install limit for the repo's own dependencies. Installing it on every run was rejected because it downloads it each time and uses up that limit. A repo that pins another pytest version reinstalls it from its own `requirements.txt`.
  - **The diff is captured before the test step.** Otherwise `node_modules/`, `__pycache__/` and `.pytest_cache/` would end up in the patch for any repo that does not ignore them, and then in a pushed branch. The diff block is still printed last, so event order is unchanged.
  - **`skip` is matched in any letter case** and normalised once in the control plane. Its reason text is "skipped by request", which keeps it apart from "no tests found".
  - **The duplicate-run check stays `repoUrl + task`.** It exists to stop an accidental double submit, and the same repo and task with a different test command is almost always that mistake.
  - **Only `tests/test_*.py` files directly inside `tests/` count as pytest evidence.** Repos with nested test folders almost always also have `pytest.ini`, `conftest.py` or `[tool.pytest`, which are detected anyway.
- **Security:** a custom command is shell run inside the disposable VM, with the same trust as the task text. The request guard still protects the API, redaction covers anything it prints, and no new secrets are introduced. The detector's own output only ever contains fixed strings.
- **Evidence (2026-11-25, details and sample sizes in VALIDATION.md section 11):** 525 unit and script tests (with fake `npm`, `python3` and pip programs), green on Ubuntu and Windows. Real runs on the rebuilt image: `jyvnn/hospital-queue` was detected as PHP and ended done with "Tests passed" (also through the old smoke path), and `johnsiega/goats-hsw-rag-chatbot` ended done with a grey "Tests not run: no tests found" where it used to end in error. The `pip install pytest` line built on the first try.
- **Gaps:** the Node and Python detection and install paths, the 180 s limit against a real slow install, a custom command and `skip` have **not** run in a real MicroVM. The first real runs on the new image were slow to first output (29 to 48 s against an earlier median of 6.8 s); three more back-to-back runs got faster each time (first activity 31.8, 14.2, 6.8 s), which fits a warm-up effect on a fresh image. That is not proven: the cause was not isolated and the old image was not compared.
