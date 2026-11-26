# Proving the test paths in real MicroVMs: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real MicroVM runs prove the Node detection, Python detection, typed-command, `skip` and failing-command paths, using two tiny public fixture repos. Any bug found is fixed test-first.

**Architecture:**
- No product code changes unless a run fails.
- A new gated integration test drives five real runs through the real control plane, as `tests/integration/end-to-end.test.ts` does, and asserts each run's `test_result` and status.
- The fixture repos are created from files kept in this plan, so they can be rebuilt.

**Tech Stack:** Node 22 `node:test`, the existing control plane, the image `hq-smoke-1795605632129` (python3, pytest and detect-tests already in it), and `gh` for creating repos.

**Spec:** [`docs/superpowers/specs/2026-11-26-real-test-paths-design.md`](../specs/2026-11-26-real-test-paths-design.md)
**Status:** draft. Depends on the owner approving the spec. Not yet implemented.
**Release:** v1.1.0, item 3 of 4. Independent of items 1 and 2. If item 1 has shipped, these runs also exercise per-run keys; record which mode was on.

## Global Constraints

- Creating each fixture repo is a **public write: [go]** first. The same goes for any later change to them.
- Every batch of real runs is a **[go]**, with its cost.
- A bug: use the systematic-debugging skill, a failing unit test first, a red run, "tests approved", the fix. If `scripts/runner/` changes, rebuild the image (its own [go]) and repeat only the affected runs.
- The fixture repos hold no secrets, no `.github/` folder, MIT licence, and a README line: "Fixture for Throwbox's real test-path checks. Not a real project."
- Scan before every push (`sk-or-`, `github_pat_`, `AKIA`, 12-digit ids, the owner's email, `C:\Users`).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Baseline after this plan: 578 + 5 skipped integration tests, which is **583 tests: 577 pass, 6 skipped**. Update the README "Development checks" line.

## What the code says (checked on 2026-11-26)

| Fact | Where | Consequence |
|---|---|---|
| Detection order: `composer.json`, then a `package.json` with a real `test` script, then pytest evidence. | `scripts/runner/detect-tests.mjs:25-33` | Two repos. The Node fixture must not contain `.py` test files, and the Python fixture must not contain `package.json`. |
| Node install is `npm ci \|\| npm install`. | `detect-tests.mjs:30` | A lockfile with no dependencies makes `npm ci` succeed, so the fallback is not exercised (listed as not covered). |
| Python evidence includes `tests/test_*.py` directly in `tests/`. | `detect-tests.mjs:19-22` | The fixture uses exactly that, and no `pytest.ini` or `conftest.py`, to prove that path. |
| Python install is `python3 -m pip install -q -r requirements.txt` as the VM's user, into the system Python. | `detect-tests.mjs:31`, `Dockerfile` | Whether pip may write there on AL2023 (an "externally managed" refusal, or permissions) is **unknown**. R2 settles it. |
| `skip` matches in any letter case and is normalised in the control plane. | `docs/DECISION_LOG.md` (piece 1, decisions) | R4 sends `SKIP`. |
| A typed command runs as `bash -c "$TEST_CMD"`, and its exit code becomes `test_result.exitCode`. | `scripts/runner/run-task.sh:53-64` | R5's `node -e "process.exit(3)"` should give 3 and run status `error`. |
| An empty diff ends the run in error. | `api/run-controller.ts:69-71` | Every task edits a file. |
| The integration test style: start `createApp` on port 0, POST `/runs`, read the SSE stream to its end, GET `/runs/:id`. | `tests/integration/end-to-end.test.ts` | Copy it. `npm test` already includes `tests/integration/*.test.ts`. |
| The quota allows 4 VMs at once. | memory, `docs/VALIDATION.md` | R1 to R4 in parallel, then R5. |

## Fixture contents (exact)

**`throwbox-fixture-node`**
- `package.json`: `{"name":"throwbox-fixture-node","version":"1.0.0","private":true,"license":"MIT","scripts":{"test":"node --test"}}`
- `package-lock.json`: `{"name":"throwbox-fixture-node","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"throwbox-fixture-node","version":"1.0.0","license":"MIT"}}}`
- `math.js` (CommonJS, since `package.json` has no `"type"`): `function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n`
- `math.test.js`: `const test = require("node:test"); const assert = require("node:assert"); const { add } = require("./math.js"); test("add", () => assert.strictEqual(add(2, 3), 5));`
- `README.md` and `LICENSE`.

**`throwbox-fixture-python`**
- `calc.py`: `def add(a, b):\n    return a + b\n`
- `tests/test_calc.py`: `from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n`
- `requirements.txt`: `text-unidecode==1.3` (pure Python, tiny, and unlikely to be in the image; unverified).
- `README.md` and `LICENSE`.

Before creating them, prove both locally with no cost:
- Node: `npm ci && npm test` in a scratch copy.
- Python: `python -m pytest -q`, if Python is installed locally; otherwise say so.

Tasks: "Add a one-line comment directly above the add function in math.js (calc.py) saying what it returns. Change nothing else."

---

### Task 1: Gated integration test (`tests/integration/test-paths.test.ts`)

**Files:** create `tests/integration/test-paths.test.ts`.

**Interfaces:**
- `async function realRun(base: string, body: { repoUrl: string; task: string; testCommand?: string }): Promise<{ status: string; tests: TraceEvent | undefined; doneExit: number; diff: string; ms: number }>`, local to the file.
- It writes `docs/measurements/test-paths.json` only when `TEST_PATHS_OUT` is set.

Tests, each skipped unless `RUN_INTEGRATION=1` and `MICROVM_IMAGE_ARN` are set. Repos come from `FIXTURE_NODE` and `FIXTURE_PYTHON`, defaulting to the two `johnsiega/throwbox-fixture-*` URLs:

| Test | Asserts |
|---|---|
| `@integration node fixture: auto-detects npm test` | status `done`; `test_result.exitCode` 0; no `skipped`; the diff touches `math.js` |
| `@integration python fixture: auto-detects pytest` | the same, with `calc.py` |
| `@integration typed command runs as given` | `testCommand: "node --test math.test.js"`; `done`, exit 0 |
| `@integration SKIP skips the tests` | `testCommand: "SKIP"`; `done`; `skipped === "skipped by request"` |
| `@integration a failing typed command fails the run` | `testCommand: 'node -e "process.exit(3)"'`; status `error`; `test_result.exitCode` 3; `done.exitCode` 3; the diff is present |

The first four start together with `Promise.all`; the fifth runs after them. Every test also asserts that the SSE bytes do not contain the OpenRouter key, as end-to-end does.

- [ ] **Step 1: Write the file.**
- [ ] **Step 2: Run `npm test`.** Expect 583 tests (577 pass, 6 skipped) and no failures. Because they are skipped by default, this is the "red run" for an integration file: it proves they are wired up and skipped.
- [ ] **Step 3: "tests approved" gate.** The owner reviews the assertions before any real run.
- [ ] **Step 4: Commit** `test: gated real-MicroVM checks for the Node, Python, typed, skip and failing test paths`.

### Task 2: Create the fixture repos

- [ ] **Step 1: Local proof** (above), with no cost. Write the files under the scratchpad, not this repo.
- [ ] **Step 2: Show the owner the exact files and commands, then wait for [go 1].**

```powershell
gh repo create johnsiega/throwbox-fixture-node --public --license mit --description "Fixture for Throwbox real test-path checks"
gh repo create johnsiega/throwbox-fixture-python --public --license mit --description "Fixture for Throwbox real test-path checks"
```

  Then clone each, add the files, scan, commit and push to `main`. Cost $0. **Public write.**
- [ ] **Step 3: Check:**
  - `gh api repos/johnsiega/throwbox-fixture-node/contents` lists exactly the expected files, with no `.github`;
  - the same for python;
  - Actions are off: `gh api -X PUT repos/<repo>/actions/permissions -F enabled=false`, part of the same go.

### Task 3: Real runs

- [ ] **[go 2] One batch.**

```powershell
$env:AWS_PROFILE = "kumpas-harness"; $env:RUN_INTEGRATION = "1"; $env:MICROVM_IMAGE_ARN = "<arn of hq-smoke-1795605632129>"; $env:TEST_PATHS_OUT = "docs/measurements/test-paths.json"
node --test tests/integration/test-paths.test.ts
```

  Cost: 5 runs at about $0.002 of model each (about $0.01), plus 5 MicroVMs for about 1 to 3 minutes each (AWS compute cost not measured; earlier runs were "a few cents"). The first runs on an idle image can be slow, so the per-test timeout is 10 minutes.
- [ ] **Step 2: For each failing run:**
  - read its events in `test-paths.json` and decide whether the cause is the fixture, the runner or the control plane;
  - a fixture bug: fix the fixture (its own go), then rerun that test alone with `--test-name-pattern`;
  - a product bug: Task 4;
  - flaky model behaviour (an empty diff, for example): rerun once and record both attempts.

  Never loosen an assertion to make a run pass.
- [ ] **Step 3:** Replace the real image ARN with `<image-arn>` in the committed measurement. Commit `docs: real test-path measurements`.

### Task 4 (only if a product bug is found): fix it test-first

- [ ] **Step 1:** Write a failing unit test that reproduces it in `scripts/runner/detect-tests.test.ts`, `scripts/smoke-test.test.ts` (run-task.sh is tested there with fake programs, from line 99) or `tests/unit/…`.
- [ ] **Step 2:** A red run with an assertion failure, then the **"tests approved" gate**.
- [ ] **Step 3:** The fix, green, `npm test`, commit `fix: …`.
- [ ] **Step 4:** If `scripts/runner/` changed: **[go 3] rebuild the image.**

```powershell
$env:AWS_PROFILE = "kumpas-harness"; $env:SMOKE_BUCKET = "<bucket>"; $env:SMOKE_BUILD_ROLE_ARN = "arn:aws:iam::<account-id>:role/hq-smoke-microvm-build"
npm run smoke
```

  It takes about 3 minutes and includes one hospital-queue run (about $0.002 plus MicroVM time). If item 2 has shipped, use `npm run setup:aws -- --rebuild-image` instead. Then [go 2] again for the affected tests only.

### Task 5: Docs

- [ ] **VALIDATION:** a new section, "13. Real test paths": per run, its repo, command, outcome, duration, date and image.
- [ ] **DECISION_LOG:** in the piece-1 entry, update "Gaps" to what is now proven and what is still not.
- [ ] **README:**
  - "Test command": remove the implication that only PHP was tried, if there is one;
  - the "Development checks" count: 583 (577 pass, 6 skipped).
- [ ] Scan, commit `docs: Node, Python, typed and skip test paths proven in real MicroVMs`. Push only with the owner's go, then `gh run watch`.

## Not verified by this plan

- `npm ci` falling back to `npm install`, and Node packages installed from the network (the fixture has no dependencies).
- The 180-second install limit against a really slow install.
- A repo that has both Node and Python, and Go, Rust or Java.
- `pytest.ini`, `conftest.py` and `[tool.pytest` detection in a real VM (only the `tests/test_*.py` path).
- Whether `text-unidecode` was really absent from the image, so that pip downloaded it rather than finding it.
- Model quality on these tasks beyond "one comment added" (five runs, one each).
