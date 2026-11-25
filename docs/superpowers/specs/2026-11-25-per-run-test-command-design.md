# Per-run test command: design

Status: approved in brainstorming, 2026-11-25. Not yet implemented. This is piece 1 of three; the other two are listed under "Not in this spec".

## Problem

The sandbox test step is hardcoded in `scripts/runner/run-task.sh` as `composer install --no-interaction && php artisan test`. On any non-PHP repo (for example `johnsiega/goats-hsw-rag-chatbot`, a Python Gradio app) the command fails with "Composer could not find a composer.json", the run ends `error` ("Tests failed"), and the push is blocked, even though the agent's edit was fine. A repo with no tests can never end green.

## Behaviour

- The form gets an optional **Test command** box. Blank means auto-detect. The word `skip` skips tests. Anything else is run as the test command (at most 500 characters, a string).
- `POST /runs` accepts an optional `testCommand`. The control plane validates it and sends it to the runner in the start request, next to `repoUrl` and `task`.
- Inside the VM, after the clone, `run-task.sh` asks `scripts/runner/detect-tests.mjs` what to do. An explicit command from the user wins over detection.
- **Detection, first match wins:**
  1. **PHP:** `composer.json` exists. Command: `composer install --no-interaction && php artisan test` when `artisan` exists, otherwise `composer install --no-interaction && vendor/bin/phpunit`. For the demo repo (`jyvnn/hospital-queue`) the result must equal today's command exactly.
  2. **Node:** `package.json` has a `test` script that is not npm's placeholder (`echo "Error: no test specified" && exit 1`). Command: `npm ci || npm install`, then `npm test`.
  3. **Python:** pytest evidence exists: `pytest.ini`, a `[tool.pytest` section in `pyproject.toml`, `conftest.py`, or a `tests/` directory containing `test_*.py`. Command: `pip install -r requirements.txt` when that file exists, then `python3 -m pytest -q`.
  4. Otherwise: tests are not run, reason "no tests found".
- Dependency installs (Node and Python) are limited to 180 seconds. A failed or timed-out install means tests are not run, reason "dependencies could not be installed".
- **Outcome:** "tests not run" ends the run `done` (so the diff stays pushable). It is shown as a grey **Tests not run** step with the reason, never as green "Tests passed".

## Event and UI

- `test_result` gains an optional field `skipped?: string` (the reason). When tests do not run, the runner reports `exitCode: 0` and `skipped`, and the parser's summary reads `tests not run: <reason>`.
- `run-view.ts` stores `test.skipped`. `RunRail` renders a grey "Tests not run" step with the reason. The Terminal badge is grey. Nothing in the UI shows green for a skipped step.

## Outcome rule

Unchanged. A run is `error` when the agent exits non-zero, the diff is empty or missing, or an explicit or detected test command really fails. A skipped test step counts as test exit 0, so it cannot turn a good diff red.

## Errors and security

- A bad `testCommand` (not a string, over 500 characters) answers 400 and nothing is started.
- A crash inside detection never fails the run: it becomes "tests not run: detection failed".
- A custom command is shell run inside the disposable VM, with the same trust as the task text. The request guard still protects the API, and redaction covers anything it prints. No new secrets are introduced.

## Testing (written first, with a "tests approved" gate)

- `detect-tests.mjs` unit tests on fake repos in temp directories: each ecosystem, the priority order, npm's placeholder script, malformed `package.json`, no match, and an exact-match regression for the demo repo's PHP command.
- Server tests for `testCommand` validation (accepted, `skip`, too long, wrong type).
- A launcher test that the runner start request carries `testCommand`.
- An event-parser test for the `skipped` field.
- A run-controller test that a skipped test step ends `done`, and that a real failure still ends `error`.
- Run-view and rail tests for the grey "Tests not run" state.
- The runner's existing server tests are extended for the new start-request field.

## Rollout (needs separate explicit "go" for each real-AWS step)

1. Rebuild the image (`npm run smoke`, about 3 minutes, cents). The runner lives in the image, so this is unavoidable.
2. One real run on `jyvnn/hospital-queue`: must still end green with tests passed (regression).
3. One real run on `johnsiega/goats-hsw-rag-chatbot`: expected green, with tests not run or passed, never red from a missing `composer.json`.
4. Update `docs/VALIDATION.md` and the decision log; the old image can be deleted afterwards.

## Out of scope

A per-repo config file, dependency caching, other languages (Go, Rust, Java), running tests in parallel, and changing the outcome rule for real failures.

## Not in this spec (next brainstorms)

- **Auto-PR:** after the agent produces a diff, the control plane opens a GitHub pull request itself, so the work reaches "prod" without manual steps. Open questions: which repos and which token scope, the one-push-per-run and branch rules, human approval before merging, and keeping the token out of the sandbox.
- **v2 scaling and improvements:** the real concurrency ceiling (an 8 GB account quota, 4 runs), a persistent run store, authentication, a hosted option, and a queue for runs beyond the quota.
