# Per-run model key: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `OPENROUTER_MANAGEMENT_KEY` set, every control-plane run gets its own OpenRouter key, capped at `RUN_KEY_LIMIT_USD` and expiring after 30 minutes. That key is the only one sent to the VM, and it is deleted when the VM is terminated.

**Architecture:** A small client, `api/openrouter-keys.ts`, with `fetch` injected (the pattern of `api/github-pr.ts`), plugs into `createMicrovmLauncher` as an optional `runKeys` provider. The launcher already owns the VM lifecycle (launch, then terminate in `executeRun`'s `finally`), so key creation and deletion hang off that lifecycle and the run controller hardly changes.

**Tech Stack:** Node 22 (TypeScript run directly, `node:test`), Hono, the OpenRouter management API (`/api/v1/keys`).

**Spec:** [`docs/superpowers/specs/2026-11-26-per-run-model-key-design.md`](../specs/2026-11-26-per-run-model-key-design.md)
**Status:** spec and plan approved by the owner on 2026-11-26. Not yet implemented.
**Release:** v1.1.0, item 1 of 4.

## Global Constraints

- TEST FIRST in every code task: tests and a stub, then a red run in which every failure is an assertion. **Stop at the "tests approved" gate.** Only then implement.
- Every real call (OpenRouter or AWS) is its own **[go]** gate, with the command and a cost estimate.
- **I never read, print or create secrets.** The owner creates the management key in the OpenRouter dashboard and adds `OPENROUTER_MANAGEMENT_KEY=...` to `.env` themselves. Scripts read `.env` through `loadDotEnv` and never print a key.
- Every push is public. Scan the staged diff for `sk-or-`, `github_pat_`, `AKIA`, 12-digit account ids, the owner's email and `C:\Users` paths. Never commit `.env`. After each push, run `gh run watch` and report.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `RUN_KEY_LIMIT_USD`: default `0.10`; must be a finite number with `0 < x < 1000000`; otherwise startup stops with `RUN_KEY_LIMIT_USD must be a positive number of US dollars below 1000000`.
- Expiry: `expires_at = new Date(now() + 30 * 60_000).toISOString()`. The format includes seconds and milliseconds, which the docs allow.
- Key name: `throwbox-run-<runId>`. If the launcher gets no run id, it uses `throwbox-run-<now()>`.
- Error texts, fixed, with only the status number added:
  - `could not create a per-run OpenRouter key (HTTP <n>)`
  - `could not create a per-run OpenRouter key (OpenRouter unreachable)`
  - `could not create a per-run OpenRouter key (unexpected answer)`
  - `could not delete the per-run OpenRouter key (HTTP <n>)`
- With the feature off, every existing test passes unchanged and no request goes to `openrouter.ai`.

## What the code says (checked on 2026-11-26)

| Fact | Where | Consequence |
|---|---|---|
| `aws.run(input)` is called **before** the `try` in `launch()`. | `api/microvm-launcher.ts:44` | A throw from `aws.run` (a quota refusal, for example) skips the cleanup. The key needs its own `try` around `aws.run`. |
| `launch(req)` gets only the `RunRequest`, not the run id. | `api/types.ts:59`, `api/run-controller.ts:36` | Add an optional `runId` parameter; `executeRun` passes `id`. Existing fakes ignore it. |
| `buildRunRequest` needs `apiKey` to build and size-check the payload. | `scripts/smoke-test.ts:96-111` | Validate once with a placeholder of the same shape (`"sk-or-v1-" + "0".repeat(64)`), create the key, then build again with the real key. The second build re-checks the size. |
| `terminate(h)` swallows errors, and `executeRun` always calls it in `finally`. | `microvm-launcher.ts:36-38`, `run-controller.ts:84-86` | Deleting the key inside `terminate` covers success, failure and timeout without any change to the controller. |
| The redactor is built from `[apiKey, GIT_PUSH_TOKEN, GIT_PR_TOKEN]`. | `api/main.ts:42` | Add `OPENROUTER_MANAGEMENT_KEY`. Per-run keys match the existing `sk-or-` prefix rule. |
| `resolveMode` requires `OPENROUTER_API_KEY` for real mode. | `api/mode.ts:5-10` | Unchanged (decided in the spec). A test proves the long-lived key never reaches the payload when per-run keys are on. |
| `SandboxHandle` has no field for the key. | `api/types.ts:54` | Add `keyHash?: string`. |

## File map

| File | Change | Responsibility |
|---|---|---|
| `api/openrouter-keys.ts` | **create** | `createRunKeys`, `parseRunKeyLimit`, and the `RunKeys` type |
| `api/types.ts` | modify | `SandboxHandle.keyHash?`; `MicroVMLauncher.launch(req, runId?)` |
| `api/microvm-launcher.ts` | modify | optional `runKeys`; create the key after validation; delete it on every exit path |
| `api/run-controller.ts` | modify (one line) | `launcher.launch(rec.request, id)` |
| `api/main.ts` | modify | read the two settings, add the key to the redactor, wire `runKeys`, the startup log line |
| `scripts/check-run-keys.ts` | **create** | the $0 rollout check (prints HTTP statuses only) |
| `tests/unit/openrouter-keys.test.ts` | **create** | client and limit tests |
| `tests/unit/microvm-launcher.test.ts` | modify | the per-run key group |
| `tests/unit/run-controller.test.ts` | modify | the run id reaches `launch` |
| `tests/unit/redaction.test.ts` | modify | the management key is redacted |
| `README.md`, `SECURITY.md`, `docs/DECISION_LOG.md`, `docs/VALIDATION.md`, `docs/EXPLAINED.md` | modify | settings, the zero-retention note, results |

---

### Task 1: OpenRouter key client (`api/openrouter-keys.ts`)

**Files:** create `api/openrouter-keys.ts` and `tests/unit/openrouter-keys.test.ts`.

**Interfaces (produced):**

```ts
export interface RunKeys {
  create(label: string, ttlMs?: number): Promise<{ key: string; hash: string }>; // ttlMs default 30 min; throws Error with a fixed message
  delete(hash: string): Promise<void>;                          // throws Error with a fixed message
}
export function createRunKeys(o: {
  managementKey: string; limitUsd: number;
  fetch?: FetchLike; now?: () => number; timeoutMs?: number; // timeoutMs default 15_000
}): RunKeys;
export function parseRunKeyLimit(raw: string | undefined): number; // undefined or "" gives 0.10; invalid throws
```

- [ ] **Step 1: Stub.** Each export throws `new Error("not implemented")`, except `parseRunKeyLimit`, which returns `NaN`.
- [ ] **Step 2: Tests.** Groups, each a `describe`:
  - **create request:** one POST to exactly `https://openrouter.ai/api/v1/keys`.
    - headers `Authorization: Bearer <mgmt>` and `Content-Type: application/json`;
    - the body deep-equals `{ name: label, limit: limitUsd, expires_at }`, with `expires_at` equal to `new Date(now()+1_800_000).toISOString()` and matching `/T\d{2}:\d{2}:\d{2}/`;
    - an `AbortSignal` is passed;
    - `create(label, 60_000)` sets `expires_at` to `now()+60_000`.
  - **create answer:** 201 `{ data: { hash: "h1" }, key: "sk-or-v1-abc" }` gives `{ key, hash }`.
  - **create failures:** each throws the fixed text, and the text never contains the management key or `sk-or-`:
    - 401, 403, 429 and 500;
    - a 201 without `key` or with a non-`sk-or-` key;
    - a 201 without `data.hash`;
    - a fetch that rejects, and a timeout.
  - **delete:** one DELETE to `https://openrouter.ai/api/v1/keys/h1` with the same auth header.
    - 200 resolves;
    - 404 resolves too: the key is already gone, which is the goal;
    - 500 and a network error throw the fixed text.
    - A hash that does not match `/^[A-Za-z0-9_-]{1,128}$/` throws **before** any fetch (no path injection).
  - **parseRunKeyLimit:**
    - `undefined` and `""` give `0.1`; `"0.25"` gives `0.25`;
    - `"0"`, `"-1"`, `"abc"`, `"1e6"`, `"Infinity"` and `" "` throw the fixed text.
- [ ] **Step 3: Red run.** `node --test tests/unit/openrouter-keys.test.ts`. Every failure must be an assertion or "not implemented"; no syntax or import errors.
- [ ] **Step 4: "tests approved" gate.** Stop and wait.
- [ ] **Step 5: Implement.** Follow `createGithubPrs`: one `call(method, path, body?)` helper that returns `null` on a network error. The `FAIL` messages are built only from the status number.
- [ ] **Step 6: Green.** Run the file, then `npm test` (expect 577 + the new tests, 1 skipped).
- [ ] **Step 7: Commit** `feat: OpenRouter per-run key client (create with limit and expiry, delete)`.

### Task 2: Launcher lifecycle

**Files:** modify `api/types.ts`, `api/microvm-launcher.ts` and `api/run-controller.ts:36`. Tests: `tests/unit/microvm-launcher.test.ts` and `tests/unit/run-controller.test.ts`.

**Interfaces:**
- Consumes: `RunKeys` from Task 1.
- Produces:
  - `createMicrovmLauncher({ ..., runKeys?: RunKeys })`
  - `launch(req: RunRequest, runId?: string): Promise<SandboxHandle>`
  - `SandboxHandle.keyHash?: string`
  - `terminate(h: Pick<SandboxHandle, "microvmId" | "keyHash">)`

Flow inside `launch` when `runKeys` is set:

```ts
buildRunRequest({ ...args, apiKey: PLACEHOLDER });            // throws on a bad repo, model or size: no key is created
const k = await o.runKeys.create(`throwbox-run-${runId ?? now()}`); // throws: no VM, no fallback
let started;
try { started = await o.aws.run(buildRunRequest({ ...args, apiKey: k.key })); }
catch (e) { await dropKey(k.hash); throw e; }                  // a quota refusal still deletes the key
// ...then the existing ready loop; its catch calls terminate({ microvmId, keyHash: k.hash })
```

`dropKey` catches errors and logs `warning: could not delete the per-run OpenRouter key; it expires on its own` through an injected `warn` (default `console.warn`). The log line contains no key and no hash.

- [ ] **Step 1: Tests.** Add `describe("per-run OpenRouter key")` with a fake `RunKeys` that records its calls:
  - the payload's `OPENROUTER_API_KEY` equals the per-run key, and the payload contains neither the long-lived `KEY` nor the management key;
  - `create` gets `throwbox-run-<runId>`;
  - an invalid repo URL or model makes **no** `create` call;
  - `create` rejects: `aws.run` is never called, `launch` rejects with the create error, and no payload contains `KEY`;
  - `aws.run` rejects: `delete(hash)` is called once and the original error is rethrown;
  - not ready: `terminate` and `delete` are each called once;
  - `terminate(h)` calls `delete(h.keyHash)` after `aws.terminate`;
  - a `delete` failure does not reject `terminate`, and `warn` is called once with no key text;
  - **feature off:** no `runKeys`, and the payload still holds `KEY`. The existing tests stay unchanged.
  - In `run-controller.test.ts`, the fake launcher records its second argument, and it equals the run id.
- [ ] **Step 2: Stub** the new options (accepted, ignored). **Red run** `node --test tests/unit/microvm-launcher.test.ts tests/unit/run-controller.test.ts`: assertion failures only.
- [ ] **Step 3: "tests approved" gate.**
- [ ] **Step 4: Implement** the flow above. `run-controller.ts:36` becomes `launcher.launch(rec.request, id)`.
- [ ] **Step 5: Green**, then `npm test`.
- [ ] **Step 6: Commit** `feat: launcher creates a capped per-run key after validation and deletes it on every exit`.

### Task 3: Wiring, redaction, startup log

**Files:** modify `api/main.ts`. Test: `tests/unit/redaction.test.ts`.

- [ ] **Step 1: Test.** With `createRedactor([apiKey, mgmt])`, an event and a text containing the management key come out with `[REDACTED]`. This is the existing behaviour, pinned for the new key.
- [ ] **Step 2: Red run.** This test may pass straight away. It pins behaviour rather than driving new code, so say so at the gate.
- [ ] **Step 3: "tests approved" gate.**
- [ ] **Step 4: Wire `main.ts`:**

```ts
const mgmt = process.env.OPENROUTER_MANAGEMENT_KEY?.trim();
const runKeys = mgmt ? createRunKeys({ managementKey: mgmt, limitUsd: parseRunKeyLimit(process.env.RUN_KEY_LIMIT_USD) }) : undefined;
const redact = createRedactor([apiKey, mgmt ?? "", process.env.GIT_PUSH_TOKEN ?? "", prToken ?? ""]);
console.log(runKeys ? `per-run OpenRouter keys on (limit $${limit} each, 30 min expiry)` : "per-run OpenRouter keys off (set OPENROUTER_MANAGEMENT_KEY in .env to enable)");
```

  `parseRunKeyLimit` throws on a bad value; `main().catch` already prints the message and exits 1. Demo mode ignores both settings.
- [ ] **Step 5: Hand check (no AWS, no keys read).** Start with `HARNESS_DEMO=1`: there is no per-run line. Start in real mode with no management key: the line says "off". A bad limit is only checked when the management key is set, so that path is covered by the Task 1 unit test and by [go 3], not by hand. Stop the server with `netstat -ano | grep :3000` and `taskkill //F //PID <pid>`.
- [ ] **Step 6: `npm test`, then commit** `feat: wire per-run OpenRouter keys (opt-in) and redact the management key`.

### Task 4: The $0 check script (`scripts/check-run-keys.ts`)

**Files:** create `scripts/check-run-keys.ts`, with its pure parts tested in `tests/unit/openrouter-keys.test.ts`.

**Interfaces:** `export async function checkRunKeys(d: { keys: RunKeys; fetch: FetchLike; sleep(ms): Promise<void>; log(s: string): void }): Promise<0 | 1>`.

It does exactly this:
1. Create `throwbox-check-<ts>` (limit `0.01`, the normal 30-minute expiry).
2. `GET /api/v1/key` with it, expecting 200.
3. Delete it.
4. `GET` again, expecting 401 or 403, printed as "deleted key refused: yes or no".
5. Create a second key with `create(label, 60_000)`, so `expires_at` is 60 seconds out. `GET` it, expecting 200.
6. Wait 75 seconds, `GET` again, and print "expired key refused: yes or no".
7. Delete it.

It prints only labels and HTTP statuses.

- [ ] **Step 1: Tests** with a fake `fetch` and a fake `RunKeys`:
  - the log lines contain no `sk-or-`;
  - the exit code is 1 when a deleted key still answers 200;
  - the second key is always deleted, even when a step throws.
- [ ] **Step 2: Red run, then the "tests approved" gate, implement, green, commit** `feat: script that checks deleted and expired per-run keys are refused`.

### Task 5: Real checks (each one is its own **[go]**)

- [ ] **[go 1] Owner creates the management key.** OpenRouter dashboard → Management keys → create. The owner adds `OPENROUTER_MANAGEMENT_KEY=...` and, optionally, `RUN_KEY_LIMIT_USD=0.10` to `.env`. No cost. I do nothing in this step.
- [ ] **[go 2] Key refusal check.** `node scripts/check-run-keys.ts`. Cost **$0**: `GET /api/v1/key` makes no model call. It takes about 80 seconds and makes 4 management writes. Record both yes or no answers.
- [ ] **[go 3] One real run.** Start the control plane with `AWS_PROFILE=kumpas-harness` and `MICROVM_IMAGE_ARN=<image arn of hq-smoke-1795605632129>`, then run the default hospital-queue task from the UI.
  - Expect: the startup log says per-run keys are on, and the run ends `done`.
  - Then a key listing filtered to the `throwbox-run-` prefix (with `include_disabled=true`) shows the run's key gone. Add a `--list` flag to the Task 4 script that prints names and `expires_at` only.
  - Cost: about $0.002 for the model plus a few cents of MicroVM time (not measured). The first run on an idle image can be slow.
- [ ] **[go 4] Zero retention.** The owner switches on zero data retention for "All other models" at `openrouter.ai/settings/privacy`. Repeat [go 3] once.
  - Record whether it ends `done` or which error it shows.
  - Then the owner decides whether to leave it on.
  - Cost: the same as [go 3].

### Task 6: Docs

- [ ] **README:**
  - "Data boundaries": replace "use a dedicated key with a spending limit" with a per-run keys paragraph (opt-in, limit, expiry, what still leaks: up to the limit, for at most 30 minutes).
  - Add a zero-retention paragraph with the [go 4] result.
  - "Run it yourself": the two `.env` lines.
- [ ] **SECURITY.md:** the management key is a control-plane-only secret, like the GitHub tokens.
- [ ] **DECISION_LOG:** an entry with the decision, why, the evidence ([go 2] to [go 4]) and the gaps.
- [ ] **VALIDATION:** a new section with dates and results.
- [ ] **EXPLAINED:** one paragraph.
- [ ] Scan, then commit `docs: per-run OpenRouter keys and the zero-retention note`. Push **only with the owner's go**, then `gh run watch`.

## Not verified by this plan

- How the per-key limit applies to a request already in flight (not documented, and not tested).
- Whether a key at its limit fails mid-run in a way the UI shows clearly. A $0.10 limit is about 50 times one run's cost, so it is not expected to trigger.
- OpenRouter's behaviour under its 10,000-writes-a-day limit.
- The `main.ts` wiring has no unit test, as before. Only [go 3] exercises it.
- Whether deleting a key cancels a request already in flight.
