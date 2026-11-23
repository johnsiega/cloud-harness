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

## Control-plane Node version (Phase 2)
- The document specifies Node 24; development ran on Node 22.18 (native TypeScript type stripping, Hono 4). `engines` is `>=22.18`.
