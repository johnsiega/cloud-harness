# Per-run model key and zero-retention note: design

Status: scope approved in brainstorming on 2026-11-26. On the same day four corrections were applied after checking OpenRouter's documentation and the code; they are **waiting for the owner's approval**. Not yet implemented.

## Problem

The OpenRouter key travels into the sandbox, which has open internet access. A malicious repository can read the key and send it out. A stolen key keeps working until the owner notices and rotates it.

## Behaviour

- **Opt-in.** When `OPENROUTER_MANAGEMENT_KEY` is set in `.env`, every real run gets its own OpenRouter key. When it is not set, nothing changes.
- **Per run:**
  - After the request has been validated, the control plane creates a key with a spending limit and an expiry.
  - It puts only that key in the run hook payload.
  - It deletes the key when the run's VM is terminated.
- **Limits:** `RUN_KEY_LIMIT_USD` defaults to `0.10`. It must be a positive number below 1,000,000, which is OpenRouter's maximum; any other value stops startup with a clear message. Keys expire 30 minutes after they are created, which matches the VM's `maximumDurationInSeconds: 1800` (`scripts/smoke-test.ts:109`).
- **Validate first.** The launcher checks the repo URL, the model id and the payload size before it creates a key, so a bad request never creates one.
- **Fail closed:** if creating the key fails, the run ends in error before any VM starts. The long-lived key is never used as a fallback.
- **If deleting fails,** the run's result is unchanged. The control plane logs a warning and the expiry ends the key.
- **A restart of the control plane** loses the run store, so the key is never deleted. Its 30-minute expiry is the only thing that ends it. The same holds for VMs killed with `scripts/kill-all.ts`.
- **`OPENROUTER_API_KEY` stays required** for real mode. `resolveMode` is unchanged. When per-run keys are on, that key is never sent to a VM; a test proves it. It stays required because `scripts/smoke-test.ts`, `scripts/measure-startup.ts` and `scripts/load-real.ts` still use it. Only runs started through the control plane get per-run keys.
- The management key never enters the sandbox, a request body from the browser, a log or a stored event. Management keys cannot call OpenRouter's completion endpoints, but they can create keys, so a leak would still be serious.

## Shape

- **New `api/openrouter-keys.ts`:**
  - `createRunKeys({ managementKey, fetch?, now?, timeoutMs? })` returns `{ create(label), delete(hash) }`. `fetch` is injected, as in `api/github-pr.ts`. Error messages are fixed text.
  - `parseRunKeyLimit(raw)` checks the limit.
- **Key name:** `throwbox-run-<runId>`. No task or repo text goes in it.
- **`api/microvm-launcher.ts`:**
  - It takes an optional `runKeys` provider, and `launch(req, runId?)` gets the run id.
  - It validates with a placeholder key, creates the real key, then builds the request again with it.
  - It keeps the key's hash on the handle.
  - It deletes the key on `terminate`, and also when `aws.run` throws or the VM never becomes ready.
- **`api/main.ts`** wires it in and adds the management key to the redactor. Per-run keys start with `sk-or-`, which the redactor already removes.
- **The startup log** says whether per-run keys are on and gives the limit.

## OpenRouter API, as documented (read on 2026-11-26, nothing called yet)

| What | Documented |
|---|---|
| Create | `POST https://openrouter.ai/api/v1/keys` with `Authorization: Bearer <management key>`. Body: `name` (1 to 256 characters), `limit` (USD, 0 or more, below 1,000,000), `expires_at` (ISO 8601 UTC, must include seconds; fractional seconds allowed). |
| Create response | 201 `{"data": {"hash": ..., ...}, "key": "sk-or-v1-..."}`. The key is shown only once. |
| Delete | `DELETE https://openrouter.ai/api/v1/keys/{hash}` returns 200 `{"deleted": true}`. Documented errors: 401, 403, 404, 429, 500. |
| Current key | `GET https://openrouter.ai/api/v1/key` with the key itself returns `data` with `limit`, `limit_remaining` and `expires_at`. It costs nothing. |
| Rate | Management writes count toward 10,000 requests a day. A run makes two. |
| Inference | "Management keys cannot be used to make API calls to OpenRouter's completion endpoints." |

Sources: `openrouter.ai/docs/features/provisioning-api-keys` (now titled "Management API Keys"), `openrouter.ai/docs/api/api-reference/api-keys/*`, `openrouter.ai/docs/api-reference/limits`.

## Zero data retention (documentation only)

The README and "Data boundaries" will say:
- OpenRouter can be set, at `openrouter.ai/settings/privacy`, to route only to zero-data-retention providers. There is one switch per model group, and "All other models" covers the default model.
- A per-request `provider.zdr: true` option exists. It is out of scope, because Codex builds the request.
- The provider still reads the code to answer.
- **What happens when no zero-retention provider serves the chosen model is not documented.** The docs call it unverified until rollout step 3 shows it.

## Testing (written first, with a "tests approved" gate)

Fake `fetch` and fake AWS only:
- the create request (URL, management key in the header, name, limit, expiry with seconds) and the delete request;
- invalid `RUN_KEY_LIMIT_USD` values;
- the payload carries the per-run key and never the management key or the long-lived key;
- an invalid request creates no key;
- if creating the key fails, no VM is started and there is no fallback;
- delete is called after success, failure, timeout, a VM that never became ready, and an `aws.run` that throws; a delete failure does not change the result;
- no error message or event contains any key;
- with the feature off, behaviour is identical to today.

## Rollout (each real step needs its own go)

1. The owner creates the management key and adds it to `.env`.
2. A $0 check script uses the API directly:
   - it creates a key, reads `GET /api/v1/key` with it, deletes it and reads again;
   - it creates a key that expires in about one minute, waits and reads again;
   - it prints only HTTP statuses.

   This settles whether a deleted key and an expired key are refused at once.
3. One real run: it ends `done`, and the key list shows that the run's key is gone afterwards.
4. With zero retention switched on in the account, one real run, to see whether the default model still has a provider. The result goes into the docs either way.

## Not verified, even after rollout

How the spending limit applies to a request that is already in flight. OpenRouter documents in-flight budgets only for the account, not for a key.

## Out of scope

- Restricting the sandbox's outbound network. It stays a listed limit, open to contributors.
- A key proxy.
- Running a model inside the owner's AWS account.
- Per-run keys for the smoke, measurement and load scripts.
