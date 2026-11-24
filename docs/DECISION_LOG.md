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
