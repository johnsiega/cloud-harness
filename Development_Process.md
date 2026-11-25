# \# Cloud Coding-Agent Harness — Detailed Development Process

# 

# > Status: finalized development plan, November 22, 2026 (Asia/Manila).

# > This is the executable specification for Codex and Claude Code.

# > TDD is mandatory. The implementing agent must output tests before implementation.

# > This document is also the planning prompt for Claude Code plan mode.

# 

# \---

# 

# \## 0. One-sentence definition

# 

# A cloud control plane that launches isolated Firecracker microVMs on AWS Lambda MicroVMs, runs Codex CLI headlessly against a repository, streams reasoning, terminal output, and diffs to a React UI via SSE, and delivers a patch as copyable text plus an optional branch push.

# 

# \---

# 

# \## 1. Showcase claims and evidence mapping

# 

# | Claim | Evidence |

# |---|---|

# | 100+ concurrent agents in isolated sandboxes | Simulation endpoint renders 100 concurrent traces; real mode tested at 10–20 MicroVMs and disclosed honestly |

# | Autonomous loop: analysis → generation → testing → patch | `codex exec` runs inside sandbox; repo test command executes; diff extracted |

# | Startup under 5 seconds | Measured `submit → first reasoning token` (user-perceived) and `submit → restored-runner readiness check` (infrastructure). Report cold (first launch from image) and warm (resume from suspended VM) separately, with median and p95 on the control-plane clock. State that the readiness metric excludes repo clone and model latency. |

# | React control plane streaming live traces | Hono `streamSSE` endpoint; three panels: reasoning, terminal, diff |

# 

# \---

# 

# \## 2. MVP contract (bare minimum)

# 

# 1\. User submits a public repo URL (e.g., `https://github.com/jyvnn/hospital-queue`) and a task string.

# 2\. Control plane launches one Lambda MicroVM from the prebuilt image.

# 3\. Sandbox clones the repo, runs `codex exec` with the task, runs the repo test command, captures `git diff`.

# 4\. Control plane streams `sandbox\_resuming`, `sandbox\_ready`, `reasoning`, `stdout`, `stderr`, `diff`, `done` via SSE.

# 5\. React UI renders three panels and a copy-diff button.

# 6\. `POST /runs/:id/push` applies the captured diff to a fresh clone at the run's base commit and pushes a `harness/<runId>` branch to the private repo (`johnsiega/hospital-queue-harness`) using a scoped fine-grained PAT. The token stays in the control plane.

# 7\. `POST /simulate?n=100` drives the UI with synthetic events.

# 8\. No auth, no chat history, no database. In-memory run store with 1-hour TTL.

# 

# \*\*Explicitly out of scope\*\*: multi-tenant isolation, billing, webhooks, model fine-tuning, custom LLM gateway, mobile app.

# 

# \---

# 

# \## 3. Stack decisions

# 

# | Layer | Choice | Justification |

# |---|---|---|

# | Sandbox | AWS Lambda MicroVMs (Firecracker) | VM-level isolation, snapshot-based near-instant startup, suspend/resume preserving memory and disk for up to 8 hours, per-second billing, no cluster |

# | Agent | `codex exec` headless, `-c sandbox\_mode=workspace-write -c approval\_policy=never` | `--full-auto` was removed in Codex CLI 0.147; these two config overrides are the supported equivalent |

# | Model routing | OpenRouter → `deepseek/deepseek-v4.1-flash` | 1M context, $0.05/M input and $0.20/M output; Phase 0: 5/5 correct diffs vs 2/5 for qwen3-coder-30b; $8.73 budget is more than sufficient |

# | Control plane | Node 24 + Hono | Native `streamSSE` helper for server-sent events with typed routes |

# | Frontend | React + Vite, single page | Matches showcase claim |

# | Trace store | In-memory `Map<string, RunRecord>` with TTL sweep | No DB for MVP |

# | Patch delivery | `git diff` text + optional `git push` to scoped branch | Bare minimum, testable |

# | Repo for clone | Public: `jyvnn/hospital-queue` | No PAT needed for clone |

# | Repo for push | Private: `johnsiega/hospital-queue-harness`, seeded from `jyvnn/hospital-queue`, via a fine-grained PAT scoped to that repo only | Demonstrates real remote delivery with a minimal blast radius |

# 

# \*\*Key injection\*\*: `OPENROUTER\_API\_KEY` and `GIT\_PUSH\_TOKEN` live in a gitignored `.env` file and are loaded by the control plane only. `GIT\_PUSH\_TOKEN` never enters the sandbox. The control plane applies the captured diff to a fresh clone of the target repo and pushes from there. The sandbox only receives `OPENROUTER\_API\_KEY`, which is a scoped key with a hard credit limit. It arrives in the MicroVM run hook payload (`runHookPayload`, max 16 KB; Lambda MicroVMs have no per-run environment variables, and the image must enable the run hook) and is set only in the codex child process env; it is never baked into the image or captured in the snapshot. A unit test asserts neither value appears in any log output.

# \*\*Redaction\*\*: Before any event reaches RunStore or SSE, redact exact secret values and known prefixes (`sk-or-`, `github\_pat\_`, `ghp\_`) by replacing them with `[REDACTED]`. Redaction applies to stdout, stderr, reasoning, and push responses.

# \*\*Control plane hardening\*\*: The control plane binds to 127.0.0.1 only. TASK arrives in the POST body from the control plane, then is passed to `codex` as a single argv element or child-process env var, never spliced into a shell string. `repoUrl` accepts only `https://github.com/*` URLs.

# 

# \---

# 

# \## 4. Architecture

# 

# ```text

# React UI (Vite)

# &#x20; │ POST /runs { repoUrl, task, model? }

# &#x20; ▼

# Control Plane (Hono, Node 24)

# &#x20; │ 1. RunStore.create() → RunRecord

# &#x20; │ 2. MicroVMLauncher.launch({ repoUrl, task, OPENROUTER\_KEY })

# &#x20; ▼

# Lambda MicroVM (Firecracker)

# &#x20; │ image was created from a Dockerfile that already contains

# &#x20; │ node, python, git, and codex; Lambda snapshots the initialized state

# &#x20; │ entrypoint.sh starts an idle HTTP runner on :8080 (snapshot captured here);

# &#x20; │ after restore, the control plane POSTs { repoUrl, task } to the runner;

# &#x20; │ the runner then:

# &#x20; │   git clone REPO\_URL /workspace

# &#x20; │   cd /workspace

# &#x20; │   codex exec -c sandbox\_mode=workspace-write -c approval\_policy=never \\

# &#x20; │     --skip-git-repo-check "TASK"

# &#x20; │   npm test; TEST\_EXIT=$?   \# no set -e in force

# &#x20; │   emit test\_result { exitCode: $TEST\_EXIT }

# &#x20; │   git add -A && git diff --cached > /tmp/patch.diff

# &#x20; │   echo "\_\_DIFF\_START\_\_"; cat /tmp/patch.diff; echo "\_\_DIFF\_END\_\_"

# &#x20; │   exit  (run status = error if TEST\_EXIT != 0, else done)

# &#x20; ▼

# Control Plane tails MicroVM stdout → EventParser → streamSSE

# &#x20; ▼

# React UI: Reasoning | Terminal | Diff

# ```

# 

# Lambda MicroVMs are created from a Dockerfile package uploaded to S3; Lambda executes the Dockerfile, starts the application, and captures a snapshot of the fully initialized environment. Subsequent `run-microvm` calls resume from that snapshot with rapid startup. Suspend and resume preserve memory and disk state, which is the basis of the warm-start claim.

# \*\*Entrypoint and snapshot\*\*: Lambda runs the entrypoint BEFORE capturing the snapshot, so the entrypoint must not perform the run. entrypoint.sh starts an idle HTTP runner on port 8080 that waits for a task. Lambda captures the snapshot with the runner idle. After restore, the control plane POSTs `{ repoUrl, task }` to the runner. The runner then performs clone → codex exec → test → diff → emit events, and exits after the run completes.

# \*\*Test result and diff capture\*\*: The runner executes `npm test; TEST\_EXIT=$?` (no `|| true`, and no `set -e` in force, so a failing test cannot abort before the exit code is captured), and emits a `test\_result` event with `exitCode: $TEST\_EXIT`. The run's final status is `error` if `TEST\_EXIT != 0`, not `done`. The patch is captured with `git add -A && git diff --cached > /tmp/patch.diff` so untracked new files appear in the patch.

# \*\*Stdout transport\*\*: MicroVM stdout and stderr stream to CloudWatch Logs. The control plane subscribes to the log group via a subscription filter and parses JSONL events in real time. If observed lag exceeds 2 seconds, fall back to the runner writing events to a file in S3 that the control plane polls every 500ms. Chosen (Phase 0-2, see DECISION\_LOG): the in-VM runner buffers events and the control plane polls its `/events` endpoint over HTTPS every 500 ms. Lambda MicroVMs expose no stdout or exit-code API, so CloudWatch is not on the critical path.

# 

# \---

# 

# \## 5. File structure

# 

# ```text

# cloud-harness/

# &#x20; api/

# &#x20;   server.ts                 # Hono app

# &#x20;   routes/runs.ts            # POST /runs, GET /runs/:id/stream, POST /runs/:id/push

# &#x20;   run-store.ts              # in-memory Map + TTL

# &#x20;   sse.ts                    # streamSSE formatter

# &#x20;   microvm-launcher.ts       # AWS Lambda MicroVM API wrapper

# &#x20;   event-parser.ts           # JSONL → TraceEvent

# &#x20;   patch-delivery.ts         # extractDiff, pushBranch

# &#x20; sandbox/

# &#x20;   Dockerfile

# &#x20;   entrypoint.sh

# &#x20;   codex-prompt.txt

# &#x20; web/

# &#x20;   src/App.tsx

# &#x20;   src/RunForm.tsx

# &#x20;   src/TracePanels.tsx

# &#x20;   src/useSSE.ts

# &#x20; tests/

# &#x20;   unit/

# &#x20;     event-parser.test.ts

# &#x20;     microvm-launcher.test.ts

# &#x20;     patch-delivery.test.ts

# &#x20;     run-store.test.ts

# &#x20;   integration/

# &#x20;     end-to-end.test.ts      # one real MicroVM, tiny repo

# &#x20;   simulation/

# &#x20;     simulate-100.test.ts

# &#x20; scripts/

# &#x20;   measure-startup.ts

# &#x20;   kill-all.ts

# &#x20; docs/

# &#x20;   DEVELOPMENT\_PROCESS.md    # this file

# &#x20;   VALIDATION.md

# &#x20;   DECISION\_LOG.md

# ```

# 

# \---

# 

# \## 6. Data contracts

# 

# ```ts

# type RunRequest = {

# &#x20; repoUrl: string;

# &#x20; task: string;

# &#x20; model?: string; // default "deepseek/deepseek-v4.1-flash"

# };

# 

# type TraceEvent =

# &#x20; | { type: "sandbox\_resuming"; ts: number }

# &#x20; | { type: "sandbox\_ready"; ts: number; startupMs: number }

# &#x20; | { type: "reasoning"; ts: number; text: string }

# &#x20; | { type: "stdout"; ts: number; text: string }

# &#x20; | { type: "stderr"; ts: number; text: string }

# &#x20; | { type: "test\_result"; ts: number; exitCode: number; summary: string }

# &#x20; | { type: "diff"; ts: number; diff: string }

# &#x20; | { type: "done"; ts: number; exitCode: number };

# 

# type RunRecord = {

# &#x20; id: string;

# &#x20; request: RunRequest;

# &#x20; status: "pending" | "running" | "done" | "error";

# &#x20; events: TraceEvent\[];

# &#x20; diff?: string;

# &#x20; microvmId?: string;

# &#x20; createdAt: number;

# &#x20; startupMs?: number;

# &#x20; firstTokenMs?: number;

# };

# ```

# 

# \---

# 

# \## 7. TDD strategy and test-review gate

# 

# \*\*Rule\*\*: The implementing agent must output the test file and the function signature before writing implementation. The human reviews the test against the checklist below. Only after approval does implementation begin.

# 

# \### Test-review checklist (industry standard)

# 

# | Criterion | Pass condition | Fail condition |

# |---|---|---|

# | Behavior-focused | Test name describes observable outcome | Test name describes internal call order |

# | Falsifiable | Breaking the implementation makes the test fail | Test passes with an empty return |

# | Edge cases | Covers timeout, empty input, malformed event, duplicate submit | Happy path only |

# | No tautology | Asserts concrete expected values | Only `toBeDefined()` |

# | Mock discipline | External services mocked; pure logic not mocked | Mocking the function under test |

# | Deterministic | No real network, no sleep, no unseeded randomness | Live API call in unit test |

# | Red-run evidence | Before "tests approved", the test is run against a stub implementation and fails on assertions; failing output is pasted; expected values are hand-authored | Fails on import/compile error, or expected values are derived from the same logic the test checks |

# 

# \### Unit tests (no cloud)

# \- \*\*EventParser\*\*: fixture of JSONL → exact sequence of `reasoning`, `stdout`, `diff` events.

# \- \*\*MicroVMLauncher\*\*: given `RunRequest`, assert launch parameters include `REPO\_URL`, `TASK`, `OPENROUTER\_API\_KEY`, and correct image ID. Mock AWS SDK.

# \- \*\*PatchDelivery.extractDiff\*\*: temp git repo with one modified file → non-empty unified diff.

# \- \*\*PatchDelivery.pushBranch\*\*: assert command sequence and that the token never appears in the returned log string.

# \- \*\*RunStore\*\*: create, get, TTL expiry after mocked clock advance.

# \- \*\*SSE\*\*: valid wire format `event: <type>\\ndata: <json>\\n\\n`.

# \- \*\*Redaction\*\*: given an event containing the literal `OPENROUTER\_API\_KEY` value, assert the SSE bytes and stored `RunRecord` contain no trace of it. Test both success and failure paths.

# \- \*\*PatchDelivery.extractDiff (untracked)\*\*: a newly created untracked file appears in the diff.

# \- \*\*Run completion\*\*: codex exits 0 but `npm test` exits 1 → run status is `error`, `test\_result.exitCode === 1`, and SSE reflects the failure.

# \- \*\*EventParser (split marker)\*\*: a diff marker split across two stdout chunks produces exactly one `diff` event.

# \- \*\*SSE (multi-line diff)\*\*: a multi-line diff round-trips as one event.

# \- \*\*RunStore (duplicate)\*\*: duplicate submit for the same `repoUrl` + `task` is rejected.

# 

# \### Integration test (one, marked `@integration`)

# Launch one real Lambda MicroVM with `jyvnn/hospital-queue` and task `"add a comment to the top of README.md"`. Assert run completes and diff contains the comment. Run once per phase, not on every save.

# 

# \### Simulation test

# `simulate-100.test.ts`: All simulated runs stream over ONE SSE connection, each event tagged with `runId`. Browsers limit ~6 HTTP/1.1 connections per origin; 100 EventSources would stall 94. The test asserts every runId receives at least one event and the connection does not disconnect unexpectedly. Verify in a real browser that all 100 traces render concurrently.

# 

# \---

# 

# \## 8. Implementation phases for 2 days

# 

# | Phase | Time | Gate |

# |---|---|---|

# | 0 — Baseline | 1–2h | Real Lambda MicroVM from the prebuilt image, real Codex CLI, real OpenRouter model, tiny repo, non-empty diff returned. `echo hello` is not sufficient. |

# | 1 — Sandbox + Codex | 3–4h | Prebuilt image contains `codex`; `codex exec` on `hospital-queue` returns a diff; startup measured |

# | 2 — Control plane + SSE | 2–3h | `POST /runs` launches MicroVM; `streamSSE` emits parsed events; React renders three panels |

# | 3 — Patch delivery | 1–2h | Diff is copyable; branch push to `johnsiega/hospital-queue-harness` works with scoped PAT |

# | 4 — Warm start + UI | 1–2h | `sandbox\_resuming` → `sandbox\_ready` animation; both startup metrics displayed |

# | 5 — Simulation + load script | 1h | 100 synthetic runs render; `kill-all.ts` terminates all real MicroVMs |

# | 6 — Validation + freeze | 2h | Unit tests pass; integration test passes; `VALIDATION.md` records actual numbers; `README` discloses simulation vs real |

# 

# \*\*Cut order if Phase 1 overruns\*\*:

# 1\. Branch push — the copyable diff already proves patch delivery.

# 2\. Resume animation and warm-pool tuning — keep the base snapshot timing.

# 3\. If no real-MicroVM diff by hour 6, switch `MicroVMLauncher` to local Docker running the same image and disclose.

# \*\*Never cut\*\*: the test step in the loop, real SSE streaming, both startup measurements, or honest disclosure.

# 

# \---

# 

# \## 9. Risks and fallbacks

# 

# | Risk | Fallback |

# |---|---|

# | Lambda MicroVM API unfamiliar | The AWS documentation and CDK construct are the primary references; the `MicroVMLauncher` interface isolates the API surface |

# | Codex exec auth failure | Pass `OPENROUTER\_API\_KEY` in the run hook payload (verified in Phase 0 on a real MicroVM; codex 0.171 needs `wire\_api="responses"`) |

# | 100 concurrent MicroVMs exceed quota | Simulation mode; disclose real tested number (10–20) |

# | Warm-start target not met | Report actual median/p95; distinguish cold vs warm explicitly |

# | Token leak | Test asserts token absent from all logs; pass the auth header through `GIT\_CONFIG\_\*` env vars, never argv or the URL |

# | Repo too large to clone in sandbox | Use a tiny fork or the `hospital-queue` repo; document size limit |

# 

# \---

# 

# \## 10. Completion checklist

# 

# \- \[ ] Lambda MicroVM runs `echo hello` from the prebuilt image. *(Not ticked, because no literal `echo hello` run exists. The intent is met by stronger evidence: full runs from the image, VALIDATION.md sections 2 and 3. No literal `echo hello` was run.)*

# \- \[x] `codex exec` produces a diff on a public repo. *(VALIDATION.md sections 2, 3 and 8.)*

# \- \[x] SSE streams `sandbox\_resuming`, `sandbox\_ready`, `reasoning`, `stdout`, `diff`, `done`. *(real integration test, VALIDATION.md section 8.)*

# \- \[x] React renders three panels and copies the diff. *(VALIDATION.md section 4: three panels and the Copy diff button checked in a real browser on a simulated run. The clipboard contents could not be read back there.)*

# \- \[x] Branch push works to the private repo with a scoped PAT. *(one real push, 2026-11-23, VALIDATION.md section 6.)*

# \- \[ ] Startup measured and displayed: `submit → sandbox\_ready` and `submit → first token`. *(Partly met, so not ticked: `sandbox\_ready` is measured and shown. "First token" is really the first agent message, because Codex emits no reasoning items. VALIDATION.md sections 1 and 2.)*

# \- \[x] Simulation endpoint renders 100 concurrent traces. *(Simulated, not real; checked in a real browser, VALIDATION.md section 4.)*

# \- \[x] All unit tests pass; one integration test passes. *(VALIDATION.md section 8.)*

# \- \[x] `VALIDATION.md` records actual numbers and discloses simulated vs real concurrency. *(docs/VALIDATION.md.)*

# \- \[x] `README` states data boundaries: repo contents go to OpenRouter; key never logged. *(README "Data boundaries". It also says the key is inside the sandbox while a run is going, so "never logged" is qualified there.)*

# \- \[x] `kill-all.ts` terminates all MicroVMs. *(real check, VALIDATION.md section 5.)*

# \- \[x] Decision log records every architectural choice and why. *(Audited 2026-11-25; entries added for the choices that were missing.)*

# \*\*Status note (2026-11-25).\*\* Section 1 claims "100+ concurrent agents ... real mode tested at 10–20 MicroVMs". The 100 is a simulation, and real mode was tested up to 4 MicroVMs, the limit of this account's 8 GB MicroVM memory quota. The 10–20 real-VM test is not done and needs a quota increase. See `docs/VALIDATION.md`.
