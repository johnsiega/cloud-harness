# Per-run model key and zero-retention note: design

Status: scope approved in brainstorming, 2026-11-26. Not yet implemented.

## Problem

The OpenRouter key travels into the sandbox, which has open internet access. A malicious repository can read it and send it out, and the stolen key works until the owner notices and rotates it.

## Behaviour

- **Opt-in.** With `OPENROUTER_MANAGEMENT_KEY` set in `.env`, every real run gets its own OpenRouter key. Without it, nothing changes.
- **Per run:** the control plane creates a key (`POST https://openrouter.ai/api/v1/keys`) with a spending limit and an expiry, puts only that key in the run hook payload, and deletes it when the run's VM is terminated.
- **Limits:** `RUN_KEY_LIMIT_USD` (default `0.10`, a positive number; anything else stops startup with a clear message). Expiry is 30 minutes, the VM's maximum duration.
- **Fail closed:** if creating the key fails, the run ends in error before any VM starts. The long-lived key is never used as a fallback.
- **Delete fails:** the run's result is unchanged; the control plane logs a warning, and the expiry ends the key.
- The management key never enters the sandbox, a request body from the browser, a log or a stored event.

## Shape

- New `api/openrouter-keys.ts`: `createRunKey({ runLabel })` returns `{ key, hash }`, and `deleteRunKey(hash)`. `fetch` is injected, as in `api/github-pr.ts`. Error messages are fixed text.
- `api/microvm-launcher.ts` takes an optional key provider, calls it before `aws.run`, keeps the hash on the handle, and deletes the key on terminate and on a failed launch.
- `api/main.ts` wires it and adds the management key to the redactor. Per-run keys start with `sk-or-`, which the redactor already removes.
- The startup log says whether per-run keys are on.

## Zero data retention (documentation only)

The README and "Data boundaries" explain that OpenRouter can be set, for the whole account, to route only to zero-data-retention providers; that requests fail if no such provider serves the chosen model; and that the provider still reads the code to answer.

## Testing (written first, with a "tests approved" gate)

Fake `fetch` and fake AWS only:
- the create request (URL, management key in the header, limit, expiry) and the delete request;
- invalid `RUN_KEY_LIMIT_USD` values;
- the payload carries the per-run key and never the management or long-lived key;
- create failure means no VM is started and no fallback;
- delete is called after success, failure, timeout and a failed launch; a delete failure does not change the result;
- no error message or event contains any key;
- feature off: behaviour identical to today.

## Rollout (each real step needs its own go)

1. Owner creates the management key and adds it to `.env`.
2. One real run: it ends `done`, and the key list on OpenRouter shows the per-run key gone afterwards.
3. With zero-retention switched on in the account, one real run, to confirm the default model still has a provider.

## To verify before building

The request and response field names, whether a deleted or expired key is rejected at once, and how the limit applies to a request already in flight. These come from OpenRouter's documentation and have not been tried.

## Out of scope

Restricting the sandbox's outbound network (stays a listed limit, open to contributors), a key proxy, and running a model inside the owner's AWS account.
