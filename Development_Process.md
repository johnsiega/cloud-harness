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

# | Startup under 5 seconds | Measured `submit → sandbox\_ready` (infrastructure) and `submit → first reasoning token` (user-perceived); warm-start via MicroVM snapshot resume |

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

# 6\. `POST /runs/:id/push` pushes the sandbox working tree to a branch on the private repo (`johnsiega/eportfolio`) using a scoped fine-grained PAT.

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

# | Model routing | OpenRouter → `qwen/qwen3-coder-30b-a3b-instruct` | 262K context, $0.07/M input and $0.28/M output; $8.73 budget is more than sufficient |

# | Control plane | Node 24 + Hono | Native `streamSSE` helper for server-sent events with typed routes |

# | Frontend | React + Vite, single page | Matches showcase claim |

# | Trace store | In-memory `Map<string, RunRecord>` with TTL sweep | No DB for MVP |

# | Patch delivery | `git diff` text + optional `git push` to scoped branch | Bare minimum, testable |

# | Repo for clone | Public: `jyvnn/hospital-queue` | No PAT needed for clone |

# | Repo for push | Private: `johnsiega/eportfolio` via fine-grained PAT | Demonstrates real remote delivery |

# 

# \*\*Key injection\*\*: `OPENROUTER\_API\_KEY` and `GIT\_PUSH\_TOKEN` live in a gitignored `.env` file, are loaded by the control plane only, and are injected into the MicroVM environment at launch. A unit test asserts neither value appears in any log output.

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

# &#x20; │ entrypoint.sh:

# &#x20; │   git clone REPO\_URL /workspace

# &#x20; │   cd /workspace

# &#x20; │   codex exec -c sandbox\_mode=workspace-write -c approval\_policy=never \\

# &#x20; │     --skip-git-repo-check "TASK"

# &#x20; │   npm test || true

# &#x20; │   git diff > /tmp/patch.diff

# &#x20; │   echo "\_\_DIFF\_START\_\_"; cat /tmp/patch.diff; echo "\_\_DIFF\_END\_\_"

# &#x20; ▼

# Control Plane tails MicroVM stdout → EventParser → streamSSE

# &#x20; ▼

# React UI: Reasoning | Terminal | Diff

# ```

# 

# Lambda MicroVMs are created from a Dockerfile package uploaded to S3; Lambda executes the Dockerfile, starts the application, and captures a snapshot of the fully initialized environment. Subsequent `run-microvm` calls resume from that snapshot with rapid startup. Suspend and resume preserve memory and disk state, which is the basis of the warm-start claim.

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

# &#x20; model?: string; // default "qwen/qwen3-coder-30b-a3b-instruct"

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

# 

# \### Unit tests (no cloud)

# \- \*\*EventParser\*\*: fixture of JSONL → exact sequence of `reasoning`, `stdout`, `diff` events.

# \- \*\*MicroVMLauncher\*\*: given `RunRequest`, assert launch parameters include `REPO\_URL`, `TASK`, `OPENROUTER\_API\_KEY`, and correct image ID. Mock AWS SDK.

# \- \*\*PatchDelivery.extractDiff\*\*: temp git repo with one modified file → non-empty unified diff.

# \- \*\*PatchDelivery.pushBranch\*\*: assert command sequence and that the token never appears in the returned log string.

# \- \*\*RunStore\*\*: create, get, TTL expiry after mocked clock advance.

# \- \*\*SSE\*\*: valid wire format `event: <type>\\ndata: <json>\\n\\n`.

# 

# \### Integration test (one, marked `@integration`)

# Launch one real Lambda MicroVM with `jyvnn/hospital-queue` and task `"add a comment to the top of README.md"`. Assert run completes and diff contains the comment. Run once per phase, not on every save.

# 

# \### Simulation test

# `simulate-100.test.ts` starts 100 SSE connections against the simulation endpoint and asserts all receive at least one event and none disconnect unexpectedly.

# 

# \---

# 

# \## 8. Implementation phases for 2 days

# 

# | Phase | Time | Gate |

# |---|---|---|

# | 0 — Baseline | 1–2h | AWS credentials work; one Lambda MicroVM runs `echo hello`; OpenRouter key works via `curl` |

# | 1 — Sandbox + Codex | 3–4h | Prebuilt image contains `codex`; `codex exec` on `hospital-queue` returns a diff; startup measured |

# | 2 — Control plane + SSE | 2–3h | `POST /runs` launches MicroVM; `streamSSE` emits parsed events; React renders three panels |

# | 3 — Patch delivery | 1–2h | Diff is copyable; branch push to `johnsiega/eportfolio` works with scoped PAT |

# | 4 — Warm start + UI | 1–2h | `sandbox\_resuming` → `sandbox\_ready` animation; both startup metrics displayed |

# | 5 — Simulation + load script | 1h | 100 synthetic runs render; `kill-all.ts` terminates all real MicroVMs |

# | 6 — Validation + freeze | 2h | Unit tests pass; integration test passes; `VALIDATION.md` records actual numbers; `README` discloses simulation vs real |

# 

# \*\*Hard stops\*\*:

# \- If Phase 1 exceeds 4 hours: cut branch push, deliver diff only.

# \- If Phase 2 is not streaming by hour 12: reduce UI to a single terminal panel, log reasoning as text.

# \- \*\*Never cut\*\*: TDD gate, error handling, token-safety test.

# 

# \---

# 

# \## 9. Risks and fallbacks

# 

# | Risk | Fallback |

# |---|---|

# | Lambda MicroVM API unfamiliar | The AWS documentation and CDK construct are the primary references; the `MicroVMLauncher` interface isolates the API surface |

# | Codex exec auth failure | Inject `OPENROUTER\_API\_KEY` as env var; test in Docker before Phase 1 ends |

# | 100 concurrent MicroVMs exceed quota | Simulation mode; disclose real tested number (10–20) |

# | Warm-start target not met | Report actual median/p95; distinguish cold vs warm explicitly |

# | Token leak | Test asserts token absent from all logs; use `git -c http.extraHeader` not URL embedding |

# | Repo too large to clone in sandbox | Use a tiny fork or the `hospital-queue` repo; document size limit |

# 

# \---

# 

# \## 10. Completion checklist

# 

# \- \[ ] Lambda MicroVM runs `echo hello` from the prebuilt image.

# \- \[ ] `codex exec` produces a diff on a public repo.

# \- \[ ] SSE streams `sandbox\_resuming`, `sandbox\_ready`, `reasoning`, `stdout`, `diff`, `done`.

# \- \[ ] React renders three panels and copies the diff.

# \- \[ ] Branch push works to the private repo with a scoped PAT.

# \- \[ ] Startup measured and displayed: `submit → sandbox\_ready` and `submit → first token`.

# \- \[ ] Simulation endpoint renders 100 concurrent traces.

# \- \[ ] All unit tests pass; one integration test passes.

# \- \[ ] `VALIDATION.md` records actual numbers and discloses simulated vs real concurrency.

# \- \[ ] `README` states data boundaries: repo contents go to OpenRouter; key never logged.

# \- \[ ] `kill-all.ts` terminates all MicroVMs.

# \- \[ ] Decision log records every architectural choice and why.

