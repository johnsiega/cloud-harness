# Per-run test command: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every run either runs the right tests for its repo (detected, or typed by the user) or reports a grey "Tests not run" with a reason. A non-PHP repo then no longer ends red because `composer.json` is missing.

**Architecture:** The repo exists only inside the VM, so detection runs there. `scripts/runner/detect-tests.mjs` is a pure Node module plus a tiny CLI. `run-task.sh` handles the user override (`TEST_CMD`), otherwise asks the CLI, runs any install under `timeout`, and emits `test_result` with an optional `skipped` reason. The control plane passes an optional `testCommand` from `POST /runs` through the launcher to the runner's start request. The parser, the reducer and the rail learn one new optional field. The outcome rule does not change.

**Tech Stack:** Node 22 (TypeScript run directly, `node:test`), Hono, React 19 + Vite, bash inside an AL2023 Lambda MicroVM image.

**Spec:** [`docs/superpowers/specs/2026-11-25-per-run-test-command-design.md`](../specs/2026-11-25-per-run-test-command-design.md)

## Global Constraints

- TEST FIRST in every code task. Write the tests and a stub, then do a red run where every failure is an assertion (no crash, no import error, no vacuous pass). Then **stop at the "tests approved" gate** until the user writes "tests approved". Only then implement.
- Every real-AWS step and every public write is its own **[go]** gate, with the exact command and a cost estimate. Nothing in this plan spends money without that go.
- Every push is to a PUBLIC repo. Before each push, scan the staged diff for `sk-or-`, `github_pat_`, `AKIA`, 12-digit AWS account ids, the user's email, and `C:\Users` paths. Never commit `.env`. Write account-specific values as `<account-id>`. After each push, run `gh run watch` and report the CI result.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never read or print `.env`. It holds `OPENROUTER_API_KEY` and `GIT_PUSH_TOKEN`.
- `testCommand`: optional string, **at most 500 characters**. Blank means auto-detect. `skip` skips. Anything else is run as the command.
- Dependency installs (Node and Python) are limited to **180 seconds**.
- PHP with `artisan` must produce exactly `composer install --no-interaction && php artisan test` (this is the regression for `jyvnn/hospital-queue`).
- A skipped test step counts as test exit 0. It never shows green.
- Baseline before Task 1: clean tree, HEAD at `c855262` or newer, `npm test` gives 466 tests (465 pass + 1 skipped). Confirmed on 2026-11-25.
- Windows: the Bash tool is Git Bash. Backslashes in `node -e` or heredoc strings get halved, so use the Edit tool for such text. Stop a server with `netstat -ano | grep :3000 | grep LISTEN`, then `taskkill //F //PID <pid>`.

---

## What the code actually says (checked on 2026-11-25, deltas from the spec)

| Fact | Where | Consequence for this plan |
|---|---|---|
| `TEST_CMD` already exists as an env override, with the PHP command as its default. `server.mjs` never sets it. | `scripts/runner/run-task.sh:8`, `scripts/runner/server.mjs:107-118` | Reuse the name `TEST_CMD` for the user's command, and **delete the default** (it would bypass detection). |
| `server.mjs` builds the script's env from scratch: `PATH, HOME, REPO_URL, TASK, MODEL, OPENROUTER_API_KEY, WORKDIR`. A test asserts that the server's own env does not leak. | `server.mjs:107-118`, `server.test.ts:122` | Add `TEST_CMD` only when `testCommand` was sent. |
| The runner start body is `{ repoUrl, task }`. Two tests `deepEqual` it. | `scripts/smoke-test.ts:113-120`, `smoke-test.test.ts:232`, `microvm-launcher.test.ts:125` | Add the `testCommand` key **only when it is set**, so the existing tests stay green. |
| The Dockerfile installs no `python3`, no pip and no pytest. The minimal base image's contents cannot be read from code. | `scripts/runner/Dockerfile:6-14` | Install `python3 python3-pip` explicitly and check them in the fail-early line. See decision D1 about pytest. |
| The image package is `{Dockerfile, run-task.sh, server.mjs}`, and `COPY` lists those two scripts. | `smoke-test.ts:71-73`, `Dockerfile:17` | Add `detect-tests.mjs` to both, plus a test that `COPY` covers every packaged file. |
| The runner-script tests run the **real** `run-task.sh` under Git Bash against a local origin that has **no `composer.json`** and no `artisan`. Ten tests assume the composer and php stubs are always called. | `scripts/smoke-test.test.ts:27-36, 320-366, 545-569` | Once detection exists, these tests would see "no tests found". The `makeOrigin` fixture must gain `composer.json` and `artisan` (Task 2). |
| `runScenario` copies only `run-task.sh` into the temp root. | `smoke-test.test.ts:67-69` | `run-task.sh` finds the detector as `$(dirname "$0")/detect-tests.mjs`. The fixture copies it next to the script. |
| The `test_result` shape is `{type, ts, exitCode, summary}`. The parser and run-view tests `deepEqual` it. | `api/types.ts:16`, `event-parser.ts:118-121`, `event-parser.test.ts:27,34` | Add `skipped` **only when present**. |
| The outcome rule is `codexExit === 0 && testExit === 0 && hasDiff`. | `api/run-controller.ts:236` | A skipped step reports `exitCode: 0`, so **no controller code changes**. Only tests are added. |
| The redactor redacts every string field of every event. | `api/redact.ts:15-19` | `skipped` is covered automatically. |
| `railSteps` lives in `RunRail.tsx` and has **no tests**. Node's type stripping cannot import `.tsx`. | `web/src/RunRail.tsx:7-34` | Move `railSteps` and the badge tone into `web/src/run-view.ts` so they can be tested (Task 5). |
| The duplicate check matches only on `repoUrl + task`. | `api/run-store.ts:24` | Left as is (D4). |
| `hospital-queue` has `composer.json`, `artisan`, **and** `package.json` at its root. | `gh api repos/jyvnn/hospital-queue/contents` | Detection order matters, and PHP must win. One test pins this exact shape. |
| `goats-hsw-rag-chatbot` has `app.py` and `requirements.txt` (torch CPU, gradio and others). Its only test-like file is `verification/test_fallback.py`. It has no `tests/` directory, no pytest config and no `.github/`. | `gh api repos/johnsiega/goats-hsw-rag-chatbot/contents` | The expected real result is exactly **"tests not run: no tests found"**. The Python install path and the 180 s limit will **not** be exercised for real. |
| `npm run smoke` builds the image **and then does one real hospital-queue run** with the default task. | `scripts/smoke-test.ts:447-511` | The rebuild [go] includes one model call, and that run is already a runner-level PHP regression check. |
| `loadDotEnv` never overrides a variable already set in the process. | `api/main.ts:15-21` | Pass the new `MICROVM_IMAGE_ARN` through the shell, never by editing `.env`. |

## Decisions for the user (answer before Task 1; the plan assumes the recommendation)

- **D1. pytest is not in the image.** As written, the spec runs `python3 -m pytest -q` after `pip install -r requirements.txt`. A repo that has pytest evidence but does not list pytest in `requirements.txt` would fail with "No module named pytest" and end **red**.
  - **(A, recommended)** Bake pytest into the image: `python3 -m pip install --no-cache-dir pytest` in the Dockerfile. It costs a few MB and adds no time per run.
  - (B) Install it per run instead: the Python install becomes `python3 -m pip install -q pytest -r requirements.txt` (or `... pytest` with no requirements file). It counts against the 180 s.
  - (C) Keep the spec literally and accept red runs in that case.
  - Task 1's Python constants and Task 2's Dockerfile step change if you pick B or C. Each step says how.
- **D2. Snapshot the diff before the test step (recommended).** Today `git add -A && git diff` runs *after* the tests. Laravel ignores `vendor/`, but Node and Python installs and test caches (`node_modules/`, `__pycache__/`, `.pytest_cache/`) can land in the patch when a repo does not ignore them. Moving the snapshot to just after Codex keeps everything the test step creates out of the diff. Event order on stdout is unchanged (the diff block is still printed last).
- **D3. How `skip` is handled.** The control plane trims the value and treats `skip` in any letter case as `skip`. The reason text is **"skipped by request"**. The other reasons come from the spec: "no tests found", "dependencies could not be installed", "detection failed".
- **D4. Duplicate check.** Two active runs with the same repo and task but different test commands are still treated as duplicates (409). This is the smallest choice.
- **D5. Python `tests/` rule.** Only files directly inside `tests/` count (`tests/test_*.py`), not nested folders. This follows the spec's wording.

## File map

| File | Change | Responsibility |
|---|---|---|
| `scripts/runner/detect-tests.mjs` | **create** | Pure `detectTests(dir)` and `formatPlan(plan)`, plus a CLI that prints three lines. |
| `scripts/runner/detect-tests.test.ts` | **create** | Detection unit tests on fake repos in temp folders. |
| `package.json` | modify `scripts.test` | Add `scripts/runner/detect-tests.test.ts` to the explicit file list. |
| `scripts/runner/run-task.sh` | modify | Override, detection, timed install, `skipped` line, diff snapshot before tests. |
| `scripts/runner/Dockerfile` | modify | python3, pip, pytest (D1), fail-early checks, `COPY detect-tests.mjs`. |
| `scripts/smoke-test.ts` | modify | `buildImagePackage` ships `detect-tests.mjs`. `buildRunnerPost` takes an optional `testCommand`. |
| `scripts/smoke-test.test.ts` | modify | Fixture gets `composer.json` and `artisan`, new stubs, new describe "runner script: test detection", image tests. |
| `scripts/runner/server.mjs` | modify | `POST /` accepts and validates `testCommand` and sets `TEST_CMD`. |
| `scripts/runner/server.test.ts` | modify | Tests for the new start-request field. |
| `api/types.ts` | modify | `RunRequest.testCommand?`, `test_result.skipped?`. |
| `api/server.ts` | modify | `validate()` accepts and normalises `testCommand`. |
| `api/microvm-launcher.ts` | modify | `start()` forwards `req.testCommand`. |
| `api/event-parser.ts` | modify | Maps `skipped` to the summary and the field. |
| `web/src/run-view.ts` | modify | `test.skipped`, plus `railSteps` and `testTone` moved here (pure). |
| `web/src/RunRail.tsx` | modify | Imports `railSteps` from `run-view.ts`. Renders the new `skip` tone. |
| `web/src/TracePanels.tsx` | modify | Badge class from `testTone`. |
| `web/src/RunForm.tsx` | modify | Optional **Test command** field. |
| `web/src/styles.css` | modify | Grid gets a column for the field. Grey `skip` tone for the rail and the badge. |
| `tests/unit/server.test.ts`, `microvm-launcher.test.ts`, `event-parser.test.ts`, `run-controller.test.ts`, `run-view.test.ts` | modify | Test groups listed per task. |
| `README.md`, `docs/DECISION_LOG.md`, `docs/EXPLAINED.md`, `docs/VALIDATION.md` | modify | Docs (Task 7) and measured results (Task 8). |

---

### Task 1: The detector (`detect-tests.mjs`)

**Files:**
- Create: `scripts/runner/detect-tests.mjs`
- Create: `scripts/runner/detect-tests.test.ts`
- Modify: `package.json` (the `test` script)

**Interfaces:**
- Produces: `detectTests(dir: string): { install: string; test: string } | { skip: string }`. `install` is `""` when there is nothing to install. Every value is a fixed string with no newline.
- Produces: `formatPlan(plan): string`, which is exactly three lines: `install\ntest\nskip\n` (unused fields are empty).
- Produces: CLI `node detect-tests.mjs <repo-dir>`. It prints `formatPlan(detectTests(dir))` and exits 0. It exits non-zero when the argument is missing, and also on any crash. `run-task.sh` maps a non-zero exit to "detection failed".
- The user's own command never passes through this file. `run-task.sh` handles `TEST_CMD` itself, so the line protocol only ever carries the fixed strings below.

- [ ] **Step 1: Write the stub**

```js
// scripts/runner/detect-tests.mjs (STUB: replaced in Step 5)
export function detectTests(_dir) { return { skip: "not implemented" }; }
export function formatPlan(_plan) { return ""; }
```

- [ ] **Step 2: Write the tests**

```ts
// scripts/runner/detect-tests.test.ts
// Detection on fake repos in temp folders. No network, no git. Run: node --test scripts/runner/detect-tests.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { detectTests, formatPlan } from "./detect-tests.mjs";

const CLI = join(import.meta.dirname, "detect-tests.mjs");
const LARAVEL = "composer install --no-interaction && php artisan test"; // today's hardcoded command, hand-copied
const PHPUNIT = "composer install --no-interaction && vendor/bin/phpunit";
const NODE = { install: "npm ci || npm install", test: "npm test" };
const PYTEST = "python3 -m pytest -q";
const PIP = "python3 -m pip install -q -r requirements.txt";
const NONE = { skip: "no tests found" };
const PKG = (test?: unknown) => JSON.stringify(test === undefined ? { name: "x" } : { name: "x", scripts: { test } });

function repo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "detect-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), body);
  }
  return d;
}

describe("detectTests: PHP", () => {
  test("composer.json + artisan gives exactly today's Laravel command, with no separate install", () => {
    assert.deepEqual(detectTests(repo({ "composer.json": "{}", artisan: "<?php" })), { install: "", test: LARAVEL });
  });
  test("composer.json without artisan runs phpunit", () => {
    assert.deepEqual(detectTests(repo({ "composer.json": "{}" })), { install: "", test: PHPUNIT });
  });
  test("regression: the hospital-queue root (composer.json, artisan, package.json with a test script, tests/) is PHP", () => {
    const d = repo({ "composer.json": "{}", artisan: "<?php", "package.json": PKG("vitest"), "tests/Feature/ExampleTest.php": "<?php", "phpunit.xml": "<x/>" });
    assert.deepEqual(detectTests(d), { install: "", test: LARAVEL });
  });
});

describe("detectTests: Node", () => {
  test("a real test script gives npm ci || npm install, then npm test", () => {
    assert.deepEqual(detectTests(repo({ "package.json": PKG("node --test") })), NODE);
  });
  test("npm's placeholder test script is not a test suite", () => {
    assert.deepEqual(detectTests(repo({ "package.json": PKG('echo "Error: no test specified" && exit 1') })), NONE);
  });
  test("no scripts, an empty script, or a non-string script is not a test suite", () => {
    for (const p of [PKG(), PKG(""), PKG("   "), PKG(42), JSON.stringify({ scripts: null }), "null"]) {
      assert.deepEqual(detectTests(repo({ "package.json": p })), NONE, p);
    }
  });
  test("a malformed package.json is skipped over, not fatal: detection falls through to Python, then to none", () => {
    assert.deepEqual(detectTests(repo({ "package.json": "{not json" })), NONE);
    assert.deepEqual(detectTests(repo({ "package.json": "{not json", "pytest.ini": "[pytest]" })), { install: "", test: PYTEST });
  });
});

describe("detectTests: Python (pytest evidence)", () => {
  for (const [name, files] of [
    ["pytest.ini", { "pytest.ini": "[pytest]" }],
    ["[tool.pytest in pyproject.toml", { "pyproject.toml": "[project]\nname='x'\n[tool.pytest.ini_options]\naddopts='-q'\n" }],
    ["conftest.py", { "conftest.py": "" }],
    ["tests/test_*.py", { "tests/test_app.py": "def test_x(): pass" }],
  ] as const) {
    test(`${name} is evidence; without requirements.txt there is no install`, () => {
      assert.deepEqual(detectTests(repo(files)), { install: "", test: PYTEST });
    });
  }
  test("requirements.txt adds a pip install of it", () => {
    assert.deepEqual(detectTests(repo({ "conftest.py": "", "requirements.txt": "requests\n" })), { install: PIP, test: PYTEST });
  });
  test("not evidence: pyproject.toml without [tool.pytest, tests/ without test_*.py, test files outside tests/", () => {
    assert.deepEqual(detectTests(repo({ "pyproject.toml": "[project]\nname='x'\n" })), NONE);
    assert.deepEqual(detectTests(repo({ "tests/helpers.py": "" })), NONE);
    assert.deepEqual(detectTests(repo({ "tests/sub/test_deep.py": "" })), NONE); // D5: direct children only
  });
  test("the goats-hsw-rag-chatbot shape (app.py, requirements.txt, verification/test_fallback.py) is 'no tests found'", () => {
    const d = repo({ "app.py": "", "requirements.txt": "gradio\n", Dockerfile: "FROM x", "verification/test_fallback.py": "", "verification/ui_test.py": "" });
    assert.deepEqual(detectTests(d), NONE);
  });
});

describe("detectTests: priority and no match", () => {
  test("first match wins: PHP over Node, Node over Python", () => {
    assert.deepEqual(detectTests(repo({ "composer.json": "{}", "package.json": PKG("jest"), "pytest.ini": "" })), { install: "", test: PHPUNIT });
    assert.deepEqual(detectTests(repo({ "package.json": PKG("jest"), "pytest.ini": "" })), NODE);
  });
  test("an empty repo, and a folder that does not exist, give 'no tests found'", () => {
    assert.deepEqual(detectTests(repo({})), NONE);
    assert.deepEqual(detectTests(join(tmpdir(), "does-not-exist-" + Date.now())), NONE);
  });
});

describe("formatPlan and the CLI", () => {
  test("formatPlan prints exactly three lines: install, test, skip reason", () => {
    assert.equal(formatPlan({ install: PIP, test: PYTEST }), `${PIP}\n${PYTEST}\n\n`);
    assert.equal(formatPlan({ install: "", test: LARAVEL }), `\n${LARAVEL}\n\n`);
    assert.equal(formatPlan(NONE), "\n\nno tests found\n");
  });
  test("no detected value ever contains a newline (the line protocol depends on it)", () => {
    for (const files of [{ "composer.json": "{}", artisan: "" }, { "composer.json": "{}" }, { "package.json": PKG("x") }, { "conftest.py": "", "requirements.txt": "" }, {}]) {
      const out = formatPlan(detectTests(repo(files)));
      assert.equal(out.split("\n").length, 4, JSON.stringify(out)); // three lines + the final empty piece
    }
  });
  test("the CLI prints formatPlan(detectTests(dir)) and exits 0", () => {
    const d = repo({ "package.json": PKG("node --test") });
    const r = spawnSync(process.execPath, [CLI, d], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, formatPlan(NODE));
  });
  test("the CLI without a directory argument exits non-zero and prints nothing on stdout", () => {
    const r = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
  });
});
```

Add the file to `package.json` after `scripts/runner/server.test.ts`: `"test": "node --test scripts/smoke-test.test.ts scripts/monitoring.test.ts scripts/runner/server.test.ts scripts/runner/detect-tests.test.ts tests/unit/*.test.ts tests/simulation/*.test.ts tests/integration/*.test.ts"`.

If you pick **D1 option B**, change `PYTEST`/`PIP` expectations so that the install is `python3 -m pip install -q pytest -r requirements.txt` with a requirements file and `python3 -m pip install -q pytest` without one, so the Python plan always has an install.

- [ ] **Step 3: Red run**

Run: `node --test scripts/runner/detect-tests.test.ts`
Expected: every `detectTests`/`formatPlan` test FAILS with an `AssertionError` (`deepEqual`/`equal` against the stub's `{skip:"not implemented"}` / `""`). Both CLI tests fail on assertions: the stub has no CLI, so Node exits 0 with empty stdout. Check: no `TypeError`, no `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: GATE: "tests approved"**

Show the user the test list and the red output. Stop. Implement only after the user writes "tests approved".

- [ ] **Step 5: Implement**

```js
// scripts/runner/detect-tests.mjs
// Decides how to test a freshly cloned repo inside the VM. First match wins: PHP, Node, Python, otherwise none.
// CLI: `node detect-tests.mjs <dir>` prints three lines for run-task.sh: install command (may be empty), test command, skip reason.
// Every value is one of the fixed strings below (no newlines), so the line protocol is safe. The user's own command never comes here.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const has = (dir, f) => existsSync(join(dir, f));
const read = (dir, f) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } };

function hasNodeTests(dir) {
  try {
    const t = JSON.parse(read(dir, "package.json"))?.scripts?.test;
    return typeof t === "string" && t.trim() !== "" && !t.includes("Error: no test specified"); // npm init's placeholder
  } catch { return false; } // missing or malformed package.json: not a Node test suite
}

function hasPytest(dir) {
  if (has(dir, "pytest.ini") || has(dir, "conftest.py") || read(dir, "pyproject.toml").includes("[tool.pytest")) return true;
  try { return readdirSync(join(dir, "tests")).some((f) => /^test_.*\.py$/.test(f)); } catch { return false; }
}

export function detectTests(dir) {
  if (has(dir, "composer.json")) {
    return { install: "", test: has(dir, "artisan") ? "composer install --no-interaction && php artisan test" : "composer install --no-interaction && vendor/bin/phpunit" };
  }
  if (hasNodeTests(dir)) return { install: "npm ci || npm install", test: "npm test" };
  if (hasPytest(dir)) return { install: has(dir, "requirements.txt") ? "python3 -m pip install -q -r requirements.txt" : "", test: "python3 -m pytest -q" };
  return { skip: "no tests found" };
}

export function formatPlan(p) {
  return "skip" in p ? `\n\n${p.skip}\n` : `${p.install}\n${p.test}\n\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error("usage: node detect-tests.mjs <repo-dir>"); process.exit(2); }
  process.stdout.write(formatPlan(detectTests(process.argv[2])));
}
```

(D1 option B: the Python line becomes `install: has(dir, "requirements.txt") ? "python3 -m pip install -q pytest -r requirements.txt" : "python3 -m pip install -q pytest"`.)

- [ ] **Step 6: Green run**

Run: `node --test scripts/runner/detect-tests.test.ts`, then `npm test`.
Expected: all detector tests pass. The full suite is 466 plus the new tests, with 0 failures and 1 skipped.

- [ ] **Step 7: Commit**

```bash
git add scripts/runner/detect-tests.mjs scripts/runner/detect-tests.test.ts package.json
git commit -m "feat: detect-tests.mjs, test-command detection inside the VM (PHP, Node, Python)"
```
(The commit message ends with the Co-Authored-By trailer, in this task and in every later commit.)

---

### Task 2: `run-task.sh` uses detection; image ships the detector

**Files:**
- Modify: `scripts/runner/run-task.sh`. Header comment line 3, the `TEST_CMD` default on line 8 (delete it), the test step on lines 43-45, and the diff capture on lines 47-52.
- Modify: `scripts/runner/Dockerfile`, the `RUN` block on lines 6-14 and `COPY` on line 17.
- Modify: `scripts/smoke-test.ts:71-73` (`buildImagePackage`).
- Modify: `scripts/smoke-test.test.ts`. Change the fixtures `makeOrigin`/`Scenario`/`runScenario` (lines 27-99), add a new describe block "runner script: test detection", and add new tests in "image build request".

**Interfaces:**
- Consumes: the CLI contract from Task 1 (three lines, non-zero exit on failure).
- Produces (stdout contract, used by Task 5): a run that does not test prints one line, `{"type":"test_result","ts":<ms>,"exitCode":0,"skipped":"<reason>"}`. The reason is one of `no tests found`, `skipped by request`, `dependencies could not be installed`, `detection failed`. A run that does test prints the unchanged `{"type":"test_result","ts":..,"exitCode":N}`.
- Produces (env contract, used by Task 3): `TEST_CMD` is unset or empty for auto-detect, `skip` to skip, and any other value is run with `bash -c`. `TEST_INSTALL_TIMEOUT` defaults to 180 seconds. Tests set it to 1.

- [ ] **Step 1: Update the fixtures first (no behaviour change yet)**

The fixture changes go in `scripts/smoke-test.test.ts`:
1. `makeOrigin(root, extra: Record<string, string> = LARAVEL_FILES)`, where `const LARAVEL_FILES = { "composer.json": "{}\n", artisan: "<?php\n" }`. Write each extra file before the initial commit. `makeOrigin(root, {})` creates a repo with no test evidence.
2. `Scenario` gains `origin?: Record<string, string>`, `npmCiExit?`, `npmInstallExit?`, `npmTestExit?`, `pipExit?`, `pytestExit?`, `installSleep?: number`, `installTimeout?: number`, and `detectBody?: string`.
3. `runScenario` makes these changes:
   - It writes the detector next to the script: `writeFileSync(`${root}/detect-tests.mjs`, o.detectBody ?? readFileSync(join(import.meta.dirname, "runner", "detect-tests.mjs"), "utf8"))`. It reads the source file, not `buildImagePackage()`, so a missing package entry fails the package test instead of crashing every scenario.
   - It uses `REPO_URL: o.repoUrl ?? makeOrigin(root, o.origin ?? LARAVEL_FILES)`.
   - If `o.installTimeout` is set, it sets `env.TEST_INSTALL_TIMEOUT = String(o.installTimeout)`.
   - It adds two stubs:
     ```ts
     stub(`${bin}/npm`, [
       `echo "npm $*" >> "$ROOT/calls.log"`,
       `case "$1" in`,
       `  ci) mkdir -p node_modules && echo x > node_modules/junk.js; sleep ${o.installSleep ?? 0}; exit ${o.npmCiExit ?? 0};;`,
       `  install) exit ${o.npmInstallExit ?? 0};;`,
       `  test) echo TESTOUT; echo cache > .test-cache; exit ${o.npmTestExit ?? 0};;`,
       `esac`,
     ].join("\n"));
     stub(`${bin}/python3`, [
       `echo "python3 $*" >> "$ROOT/calls.log"`,
       `if [ "$2" = pip ]; then exit ${o.pipExit ?? 0}; fi`,
       `mkdir -p .pytest_cache && exit ${o.pytestExit ?? 0}`,
     ].join("\n"));
     ```
   - It returns `ms`, the elapsed time measured around `spawnSync`.

At this point, run `node --test scripts/smoke-test.test.ts`. Expected: still all green against the **unchanged** `run-task.sh` (the hardcoded PHP command ignores the new files). This proves the fixture change alone breaks nothing.

- [ ] **Step 2: Write the new tests**

```ts
// in scripts/smoke-test.test.ts
const NODE_FILES = { "package.json": JSON.stringify({ name: "x", scripts: { test: "node --test" } }) };
const PY_FILES = { "conftest.py": "", "requirements.txt": "requests\n" };
const calls = (read: (f: string) => string) => read("calls.log").trim().split(/\r?\n/).filter(Boolean);
const testResult = (events: any[]) => events.find((e) => e.type === "test_result");

describe("runner script: test detection", () => {
  test("Laravel (composer.json + artisan, even with a package.json) still runs exactly composer install, then php artisan test", () => {
    const { read } = runScenario(makeRoot(), { origin: { ...LARAVEL_FILES, ...NODE_FILES } });
    assert.deepEqual(calls(read), ["composer install --no-interaction", "php artisan test"]);
  });

  test("a Node repo runs npm ci, then npm test, and test_result carries npm test's exit code with no skipped field", () => {
    const { read, events } = runScenario(makeRoot(), { origin: NODE_FILES, npmTestExit: 4 });
    assert.deepEqual(calls(read), ["npm ci", "npm test"]);
    assert.deepEqual(Object.keys(testResult(events)).sort(), ["exitCode", "ts", "type"]);
    assert.equal(testResult(events).exitCode, 4);
  });

  test("when npm ci fails, npm install is tried before npm test", () => {
    const { read } = runScenario(makeRoot(), { origin: NODE_FILES, npmCiExit: 1 });
    assert.deepEqual(calls(read), ["npm ci", "npm install", "npm test"]);
  });

  test("a failed install means tests not run: exit 0, skipped 'dependencies could not be installed', npm test never runs", () => {
    const { read, events, r } = runScenario(makeRoot(), { origin: NODE_FILES, npmCiExit: 1, npmInstallExit: 1 });
    assert.deepEqual(calls(read), ["npm ci", "npm install"]);
    assert.deepEqual(testResult(events), { type: "test_result", ts: testResult(events).ts, exitCode: 0, skipped: "dependencies could not be installed" });
    assert.equal(r.status, 0);
  });

  test("an install slower than TEST_INSTALL_TIMEOUT is stopped and reported as not run", () => {
    const { events, ms, read } = runScenario(makeRoot(), { origin: NODE_FILES, installSleep: 30, installTimeout: 1 });
    assert.equal(testResult(events).skipped, "dependencies could not be installed");
    assert.ok(!calls(read).includes("npm test"));
    assert.ok(ms < 20_000, `took ${ms} ms; the timeout must cut the 30 s install short`);
  });

  test("a Python repo installs requirements.txt with pip, then runs pytest", () => {
    const { read, events } = runScenario(makeRoot(), { origin: PY_FILES, pytestExit: 0 });
    assert.deepEqual(calls(read), ["python3 -m pip install -q -r requirements.txt", "python3 -m pytest -q"]);
    assert.equal(testResult(events).exitCode, 0);
  });

  test("a repo with no test evidence: no tool is called, exitCode 0, skipped 'no tests found', script exits 0", () => {
    const { read, events, r } = runScenario(makeRoot(), { origin: {} });
    assert.deepEqual(calls(read), []);
    assert.equal(testResult(events).skipped, "no tests found");
    assert.equal(testResult(events).exitCode, 0);
    assert.equal(r.status, 0);
  });

  test("TEST_CMD wins over detection and is run as given", () => {
    const { read, events } = runScenario(makeRoot(), { testCmd: "php custom-check --strict", phpExit: 6 });
    assert.deepEqual(calls(read), ["php custom-check --strict"]);
    assert.equal(testResult(events).exitCode, 6);
  });

  test("TEST_CMD=skip runs nothing and reports skipped 'skipped by request'", () => {
    const { read, events } = runScenario(makeRoot(), { testCmd: "skip" });
    assert.deepEqual(calls(read), []);
    assert.equal(testResult(events).skipped, "skipped by request");
  });

  test("a crashing detector never fails the run: skipped 'detection failed', exit 0, diff still captured", () => {
    const { events, lines, r } = runScenario(makeRoot(), { detectBody: "throw new Error('boom');" });
    assert.equal(testResult(events).skipped, "detection failed");
    assert.equal(r.status, 0);
    assert.ok(diffBlock(lines).includes(`diff --git a/${EDITED}`));
  });

  test("files created by installs and tests never reach the diff (D2: snapshot before the test step)", () => {
    const node = diffBlock(runScenario(makeRoot(), { origin: NODE_FILES }).lines);
    assert.ok(node.includes(`diff --git a/${EDITED}`), node);
    assert.ok(!node.includes("node_modules/") && !node.includes(".test-cache"), node);
    const py = diffBlock(runScenario(makeRoot(), { origin: PY_FILES }).lines);
    assert.ok(!py.includes(".pytest_cache"), py);
  });

  test("the test command's own stdout goes to stderr, never into the event stream", () => {
    const { r } = runScenario(makeRoot(), { origin: NODE_FILES });
    assert.ok(!r.stdout.includes("TESTOUT"));
    assert.ok(r.stderr.includes("TESTOUT"));
  });

  test("a skipped line is one valid JSON object, and it comes before the diff block", () => {
    const { lines } = runScenario(makeRoot(), { origin: {} });
    const i = idx(lines, '"test_result"');
    assert.deepEqual(Object.keys(JSON.parse(lines[i])).sort(), ["exitCode", "skipped", "ts", "type"]);
    assert.ok(i < idx(lines, "__DIFF_START__"));
  });
});
```

The new tests in `describe("image build request")` go next to the existing `for (const [what, re] ...)` list:

```ts
    ["python3 and pip", /python3 python3-pip/],
    ["pytest (D1 option A)", /pip install[^\n]*\bpytest\b/],
```

```ts
  test("the fail-early check verifies python3, pytest and timeout", () => {
    assert.match(df, /python3 --version/);
    assert.match(df, /python3 -m pytest --version/);
    assert.match(df, /timeout --version/);
  });

  test("the package ships detect-tests.mjs, and the Dockerfile COPYs every runner file in the package", () => {
    const pkg = S.buildImagePackage();
    assert.equal(pkg["detect-tests.mjs"], readFileSync(join(import.meta.dirname, "runner", "detect-tests.mjs"), "utf8"));
    const copied = (df.match(/^COPY (.+) \/opt\/runner\/$/m)?.[1] ?? "").split(/\s+/);
    for (const f of Object.keys(pkg).filter((k) => k !== "Dockerfile")) assert.ok(copied.includes(f), `${f} not copied`);
  });
```

(D1 option B or C: drop the `pytest` row and the `python3 -m pytest --version` assertion.)

- [ ] **Step 3: Red run**

Run: `node --test scripts/smoke-test.test.ts`
Expected failures, all `AssertionError`:
- Every Node, Python, no-test, skip, crash and artifact test fails, because the script always calls composer and php.
- "TEST_CMD wins" may already pass, since today's script honours `TEST_CMD`. Note that in the gate report as an existing behaviour that is kept on purpose.
- The image tests fail on `match`/`equal`.

Every test that existed before still passes (thanks to the fixture from Step 1).

- [ ] **Step 4: GATE: "tests approved"**

- [ ] **Step 5: Implement `run-task.sh`**

The header (line 3) becomes:
`# Env: REPO_URL TASK OPENROUTER_API_KEY MODEL [WORKDIR] [TEST_CMD: a command, or "skip"; unset = auto-detect] [TEST_INSTALL_TIMEOUT: seconds, default 180]`

Delete line 8 (`TEST_CMD="${TEST_CMD:-composer install ...}"`). After line 7, add:
```bash
RUNNER_DIR="$(cd "$(dirname "$0")" && pwd)"  # detect-tests.mjs ships next to this script (/opt/runner in the image)
```

Replace lines 43-52 (from `bash -c "$TEST_CMD"` to the end) with:
```bash
# Snapshot the patch now, so dependency installs and test caches never end up in it.
git add -A && git diff --cached --binary > "$PATCH"

# Test step. An explicit TEST_CMD wins; otherwise detect-tests.mjs prints install, test and skip reason (one per line).
TEST_INSTALL=""; TEST_RUN=""; TEST_SKIP=""
if [ "$TEST_CMD" = "skip" ]; then TEST_SKIP="skipped by request"
elif [ -n "$TEST_CMD" ]; then TEST_RUN="$TEST_CMD"
elif PLAN="$(node "$RUNNER_DIR/detect-tests.mjs" .)"; then { read -r TEST_INSTALL; read -r TEST_RUN; read -r TEST_SKIP; } <<< "$PLAN"
fi
[ -n "$TEST_RUN$TEST_SKIP" ] || TEST_SKIP="detection failed"
# timeout signals the whole process group, so npm's or pip's children stop too.
if [ -n "$TEST_INSTALL" ] && ! timeout -k 5 "${TEST_INSTALL_TIMEOUT:-180}" bash -c "$TEST_INSTALL" >&2; then
  TEST_RUN=""; TEST_SKIP="dependencies could not be installed"
fi
if [ -n "$TEST_RUN" ]; then
  bash -c "$TEST_RUN" >&2
  TEST_EXIT=$?
  emit test_result "$TEST_EXIT"
else
  TEST_EXIT=0
  # TEST_SKIP is always one of four fixed phrases (no quotes or backslashes), so it is safe inside the JSON string.
  printf '{"type":"test_result","ts":%s,"exitCode":0,"skipped":"%s"}\n' "$(now)" "$TEST_SKIP"
fi

echo "__DIFF_START__"
cat "$PATCH"
echo "__DIFF_END__"
exit "$TEST_EXIT"
```

- [ ] **Step 6: Implement the image changes**

`scripts/runner/Dockerfile`:
- In the `dnf install` list, add `python3 python3-pip` after `sqlite`.
- After `npm install -g @openai/codex`, add `&& python3 -m pip install --no-cache-dir pytest \` (D1 option A only).
- Extend the final check line: `... && git --version && python3 --version && python3 -m pytest --version && timeout --version`.
- `COPY server.mjs run-task.sh detect-tests.mjs /opt/runner/`.
- Update the comment on line 5 to mention python3 and pytest.

`scripts/smoke-test.ts:72`:
```ts
  return { Dockerfile: buildDockerfile(), "run-task.sh": buildRunnerScript(), "server.mjs": runnerFile("server.mjs"), "detect-tests.mjs": runnerFile("detect-tests.mjs") };
```

- [ ] **Step 7: Green run**

Run: `node --test scripts/smoke-test.test.ts`, then `npm test`. Expected: 0 failures.
On Windows the timeout test relies on Git Bash's `/usr/bin/timeout`. If it is flaky there, report it. Do not loosen it silently.

- [ ] **Step 8: Commit**

```bash
git add scripts/runner/run-task.sh scripts/runner/Dockerfile scripts/smoke-test.ts scripts/smoke-test.test.ts
git commit -m "feat: run-task.sh detects or takes the test command, times out installs, reports skipped tests"
```

---

### Task 3: The runner accepts `testCommand`

**Files:**
- Modify: `scripts/runner/server.mjs`. Header comment line 3, `start()` on lines 105-124, and the `POST /` handler on lines 148-157.
- Modify: `scripts/runner/server.test.ts`. Add a new describe block at the end.

**Interfaces:**
- Consumes: the `TEST_CMD` env contract from Task 2.
- Produces: `POST /` takes `{ repoUrl, task, testCommand? }`. A `testCommand` that is present but not a string, or longer than 500 characters, gets 400 and nothing starts. A non-empty string is passed to the script as `TEST_CMD`, byte for byte. When it is missing or empty, `TEST_CMD` is not set at all.

- [ ] **Step 1: Write the tests** (there is no stub: today's server ignores the field, so every test fails on an assertion)

```ts
// scripts/runner/server.test.ts, after the existing describe
describe("runner server: testCommand", () => {
  const SHOW = 'echo "TEST_CMD=${TEST_CMD-unset}"\nexit 0';
  const REPO = "https://github.com/jyvnn/hospital-queue";

  test("testCommand reaches the script as TEST_CMD, verbatim (quotes, $ and ; are not interpreted on the way)", async () => {
    const s = await start(SHOW);
    assert.ok(s.ready);
    await sendRunHook(s.base);
    const cmd = `npm run check -- --name "a b"; echo $HOME`;
    assert.equal((await post(s.base + "/", { repoUrl: REPO, task: "t", testCommand: cmd })).status, 202);
    const { lines } = await drain(s.base);
    assert.deepEqual(lines, [`TEST_CMD=${cmd}`]);
  });

  test("without testCommand (or with an empty one) TEST_CMD is not set at all, so the script auto-detects", async () => {
    for (const body of [{ repoUrl: REPO, task: "t" }, { repoUrl: REPO, task: "t", testCommand: "" }]) {
      const s = await start(SHOW);
      assert.ok(s.ready);
      await sendRunHook(s.base);
      assert.equal((await post(s.base + "/", body)).status, 202);
      assert.deepEqual((await drain(s.base)).lines, ["TEST_CMD=unset"], JSON.stringify(body));
    }
  });

  test("a testCommand that is not a string, or longer than 500 characters, answers 400 and nothing starts", async () => {
    const s = await start(SHOW);
    assert.ok(s.ready);
    await sendRunHook(s.base);
    for (const testCommand of [42, null, ["npm test"], "x".repeat(501)]) {
      assert.equal((await post(s.base + "/", { repoUrl: REPO, task: "t", testCommand })).status, 400, JSON.stringify(testCommand).slice(0, 40));
    }
    assert.equal((await fetch(`${s.base}/events`)).status, 404, "no run may have started");
  });

  test("exactly 500 characters is accepted", async () => {
    const s = await start(SHOW);
    assert.ok(s.ready);
    await sendRunHook(s.base);
    assert.equal((await post(s.base + "/", { repoUrl: REPO, task: "t", testCommand: "x".repeat(500) })).status, 202);
  });
});
```

- [ ] **Step 2: Red run**

Run: `node --test scripts/runner/server.test.ts`. Expected `AssertionError`s:
- the verbatim test gets `TEST_CMD=unset`;
- the invalid-values test gets 202 instead of 400.

The "unset" and "500 chars" tests already pass, because they pin behaviour that must not change. Say so in the gate report.

- [ ] **Step 3: GATE: "tests approved"**

- [ ] **Step 4: Implement**

The header line 3 becomes:
`//   POST /            {repoUrl, task, testCommand?}  <- control plane starts the run (once); testCommand becomes TEST_CMD`

```js
function start(repoUrl, task, testCommand) {
  ...
    env: {
      ...the existing seven keys...,
      ...(testCommand ? { TEST_CMD: testCommand } : {}), // unset means run-task.sh auto-detects
    },
```

In the `POST /` handler, after the `task` check:
```js
      if (p.testCommand !== undefined && (typeof p.testCommand !== "string" || p.testCommand.length > 500)) return send(res, 400, { error: "testCommand must be a string of at most 500 characters" });
```
Then call `start(p.repoUrl, p.task, p.testCommand)`.

- [ ] **Step 5: Green run.** Run `node --test scripts/runner/server.test.ts` and then `npm test`.

- [ ] **Step 6: Commit** `feat: runner start request accepts an optional testCommand (passed as TEST_CMD)`

---

### Task 4: Control plane: `POST /runs` takes `testCommand` and forwards it

**Files:**
- Modify: `api/types.ts:4-8` (`RunRequest`)
- Modify: `api/server.ts:105-119` (`validate`)
- Modify: `scripts/smoke-test.ts:113-120` (`buildRunnerPost`)
- Modify: `api/microvm-launcher.ts:62-66` (`start`)
- Test: `tests/unit/server.test.ts`, `tests/unit/microvm-launcher.test.ts`, `scripts/smoke-test.test.ts` ("runner POST after restore")

**Interfaces:**
- Produces: `RunRequest.testCommand?: string`. It is stored trimmed, and `skip` in any case is stored as `skip` (D3). It is absent when blank.
- Produces: `buildRunnerPost(o: { endpoint; authToken; repoUrl; task; testCommand?: string }): RunnerPost`. The body carries `testCommand` only when it is set.
- Consumes: Task 3's runner contract.

- [ ] **Step 1: Write the tests**

```ts
// tests/unit/server.test.ts, inside describe("POST /runs")
  test("an optional testCommand is trimmed and kept on the stored request", async () => {
    const s = setup();
    assert.equal((await s.post({ ...GOOD, testCommand: "  npm run check  " })).status, 202);
    assert.equal(s.store.get("run-1")?.request.testCommand, "npm run check");
  });

  test("'skip' in any letter case is stored as skip", async () => {
    const s = setup();
    await s.post({ ...GOOD, testCommand: " SKIP " });
    assert.equal(s.store.get("run-1")?.request.testCommand, "skip");
  });

  test("a blank testCommand means auto-detect: no testCommand key is stored", async () => {
    const s = setup();
    await s.post({ ...GOOD, testCommand: "   " });
    assert.ok(s.store.get("run-1"), "record must be stored");
    assert.deepEqual(s.store.get("run-1")!.request, GOOD);
  });

  test("exactly 500 characters is accepted", async () => {
    assert.equal((await setup().post({ ...GOOD, testCommand: "x".repeat(500) })).status, 202);
  });
```
Add these entries to the existing `bad` array: `{ ...GOOD, testCommand: 42 }`, `{ ...GOOD, testCommand: null }`, `{ ...GOOD, testCommand: ["npm test"] }`, `{ ...GOOD, testCommand: "x".repeat(501) }`.

```ts
// scripts/smoke-test.test.ts, in describe("runner POST after restore")
  test("adds testCommand to the body only when it is given", () => {
    const base = { endpoint: "e.on.aws", authToken: "t", repoUrl: "https://github.com/a/b", task: "t" };
    assert.deepEqual(JSON.parse(S.buildRunnerPost({ ...base, testCommand: "npm test" }).body), { repoUrl: base.repoUrl, task: "t", testCommand: "npm test" });
    assert.deepEqual(JSON.parse(S.buildRunnerPost(base).body), { repoUrl: base.repoUrl, task: "t" });
  });
```

```ts
// tests/unit/microvm-launcher.test.ts, in describe("MicroVMLauncher.start / poll / terminate")
  test("start forwards the run's testCommand to the runner (and still never the API key)", async () => {
    const s = setup();
    await s.launcher.start(handle, { ...REQ, testCommand: "skip" });
    const post = s.calls.find((c) => c.init?.method === "POST")!;
    assert.deepEqual(JSON.parse(post.init.body), { repoUrl: REQ.repoUrl, task: REQ.task, testCommand: "skip" });
    assert.ok(!JSON.stringify(post).includes(KEY));
  });
```
(Use the API-key constant the file already defines. Check its name before writing; the existing key test is at line 161.)

- [ ] **Step 2: Red run**

Run: `node --test tests/unit/server.test.ts tests/unit/microvm-launcher.test.ts scripts/smoke-test.test.ts`. Expected `AssertionError`s:
- the stored request lacks `testCommand`;
- the new bad entries get 202;
- the bodies lack `testCommand`.

The blank and 500-character tests pass already, because they pin behaviour that must not change.

- [ ] **Step 3: GATE: "tests approved"**

- [ ] **Step 4: Implement**

```ts
// api/types.ts
export type RunRequest = {
  repoUrl: string;
  task: string;
  model?: string; // default "deepseek/deepseek-v4.1-flash"
  testCommand?: string; // "skip", or a shell command run inside the VM; absent = auto-detect there
};
```

```ts
// api/server.ts validate(), after the model check
  if (b.testCommand !== undefined && (typeof b.testCommand !== "string" || b.testCommand.length > 500)) return { ok: false, error: "testCommand must be a string of at most 500 characters" };
  const testCommand = typeof b.testCommand === "string" ? b.testCommand.trim() : "";
  const req: RunRequest = {
    repoUrl: b.repoUrl, task: b.task,
    ...(b.model !== undefined ? { model: b.model as string } : {}),
    ...(testCommand ? { testCommand: testCommand.toLowerCase() === "skip" ? "skip" : testCommand } : {}),
  };
```

```ts
// scripts/smoke-test.ts
export function buildRunnerPost(o: { endpoint: string; authToken: string; repoUrl: string; task: string; testCommand?: string }): RunnerPost {
  return {
    ...unchanged url/method/headers...,
    body: JSON.stringify({ repoUrl: o.repoUrl, task: o.task, ...(o.testCommand ? { testCommand: o.testCommand } : {}) }),
  };
}
```

```ts
// api/microvm-launcher.ts start()
      const post = buildRunnerPost({ endpoint: h.endpoint, authToken: h.authToken, repoUrl: req.repoUrl, task: req.task, testCommand: req.testCommand });
```

- [ ] **Step 5: Green run.** Run `npm test`.

- [ ] **Step 6: Commit** `feat: POST /runs accepts an optional testCommand and forwards it to the runner`

---

### Task 5: The `skipped` event: parser, outcome, view state, rail

**Files:**
- Modify: `api/types.ts:16` (`test_result`)
- Modify: `api/event-parser.ts:118-121`
- Modify: `web/src/run-view.ts`. Add `test.skipped` and the reducer change, then move in `railSteps`, `Step` and `Tone` from `RunRail.tsx`, and add `testTone`.
- Modify: `web/src/RunRail.tsx`. Delete the local `railSteps`, `Step` and `Tone`, and import them from `./run-view.ts`.
- Test: `tests/unit/event-parser.test.ts`, `tests/unit/run-controller.test.ts`, `tests/unit/run-view.test.ts`
- **No change** to `api/run-controller.ts`. The tests prove that the outcome rule already handles a skipped step.

**Interfaces:**
- Produces: `TraceEvent` `{ type: "test_result"; ts; exitCode; summary; skipped?: string }`. `skipped` is present only for exit 0 with a non-empty string, and is capped at 200 characters. The summary is then `tests not run: <reason>`.
- Produces: `RunView.test?: { exitCode: number; summary: string; skipped?: string }`.
- Produces: `type Tone = "pending" | "active" | "ok" | "fail" | "skip"`; `type Step = { key; label; tone; detail?; hero? }`; `railSteps(v: RunView): Step[]`; `testTone(t: RunView["test"]): "ok" | "fail" | "skip"`. All are exported from `web/src/run-view.ts`.

- [ ] **Step 1: Stub.** In `web/src/run-view.ts`, add the `Tone`/`Step` types and `export function railSteps(_v: RunView): Step[] { return []; }`, `export function testTone(_t: RunView["test"]): "ok" | "fail" | "skip" { return "ok"; }`. Do not touch `RunRail.tsx` yet.

- [ ] **Step 2: Write the tests**

```ts
// tests/unit/event-parser.test.ts
describe("test_result: skipped", () => {
  test("exit 0 with a skipped reason becomes 'tests not run: <reason>' and carries the reason", () => {
    assert.deepEqual(parser().push(j({ type: "test_result", exitCode: 0, skipped: "no tests found" })),
      [{ type: "test_result", ts: NOW, exitCode: 0, summary: "tests not run: no tests found", skipped: "no tests found" }]);
  });
  test("a non-zero exit is a failure even if a skipped reason is present (failure wins)", () => {
    assert.deepEqual(parser().push(j({ type: "test_result", exitCode: 2, skipped: "x" })),
      [{ type: "test_result", ts: NOW, exitCode: 2, summary: "tests failed (exit 2)" }]);
  });
  test("an empty, blank or non-string skipped value is ignored", () => {
    for (const skipped of ["", "  ", 7, null, { a: 1 }]) {
      assert.deepEqual(parser().push(j({ type: "test_result", exitCode: 0, skipped })),
        [{ type: "test_result", ts: NOW, exitCode: 0, summary: "tests passed" }], JSON.stringify(skipped));
    }
  });
  test("a long reason is capped at 200 characters", () => {
    const [e] = parser().push(j({ type: "test_result", exitCode: 0, skipped: "r".repeat(500) })) as any[];
    assert.equal(e.skipped.length, 200);
  });
});
```
(Use the file's existing `parser()`, `j()` and `NOW` helpers.)

```ts
// tests/unit/run-controller.test.ts
const skippedResult = (reason: string) => J({ type: "test_result", exitCode: 0, skipped: reason });

describe("executeRun: skipped tests", () => {
  test("a skipped test step with a diff ends done (exit 0), and the event keeps the reason", async () => {
    const r = await run(fake({ chunks: [[msg("x"), codexExit(0)], [skippedResult("no tests found"), ...diffBlock()]] }));
    assert.equal(r.rec.status, "done");
    assert.deepEqual(r.rec.events.at(-1), { type: "done", ts: 5000, exitCode: 0 });
    assert.equal(r.rec.events.find((e) => e.type === "test_result")?.summary, "tests not run: no tests found");
  });
  test("a skipped step cannot rescue a failed agent or an empty diff", async () => {
    assert.equal((await run(fake({ chunks: [[codexExit(1)], [skippedResult("no tests found"), ...diffBlock()]] }))).rec.status, "error");
    assert.equal((await run(fake({ chunks: [[codexExit(0)], [skippedResult("no tests found"), ...diffBlock([])]] }))).rec.status, "error");
  });
  test("a real test failure still ends error with the test's exit code", async () => {
    const r = await run(fake({ chunks: [[codexExit(0)], [testResult(3), ...diffBlock()]] }));
    assert.equal(r.rec.status, "error");
    assert.deepEqual(r.rec.events.at(-1), { type: "done", ts: 5000, exitCode: 3 });
  });
});
```

```ts
// tests/unit/run-view.test.ts (import railSteps, testTone too)
const PASSED: TraceEvent = { type: "test_result", ts: 4, exitCode: 0, summary: "tests passed" };
const FAILED: TraceEvent = { type: "test_result", ts: 4, exitCode: 1, summary: "tests failed (exit 1)" };
const SKIPPED: TraceEvent = { type: "test_result", ts: 4, exitCode: 0, summary: "tests not run: no tests found", skipped: "no tests found" };
const finished = (t: TraceEvent) => play([{ type: "sandbox_resuming", ts: 1 }, { type: "sandbox_ready", ts: 2, startupMs: 1500 }, { type: "reasoning", ts: 3, text: "x" }, t,
  { type: "diff", ts: 5, diff: "diff --git a/f b/f\n+a\n-b\n" }, { type: "done", ts: 6, exitCode: t.exitCode }]);
// Asserts instead of using `!`, so the red run against the [] stub fails on an assertion, not a TypeError.
const step = (v: ReturnType<typeof play>, key: string) => { const s = railSteps(v).find((x) => x.key === key); assert.ok(s, `no ${key} step`); return s; };

describe("test_result: skipped in the view", () => {
  test("the reducer keeps the skipped reason; passed and failed results have no skipped key", () => {
    assert.deepEqual(finished(SKIPPED).test, { exitCode: 0, summary: "tests not run: no tests found", skipped: "no tests found" });
    assert.deepEqual(finished(PASSED).test, { exitCode: 0, summary: "tests passed" });
  });
  test("testTone: passed is ok, failed is fail, skipped is skip", () => {
    assert.equal(testTone(finished(PASSED).test), "ok");
    assert.equal(testTone(finished(FAILED).test), "fail");
    assert.equal(testTone(finished(SKIPPED).test), "skip");
  });
});

describe("railSteps (moved from RunRail.tsx; existing behaviour pinned)", () => {
  test("tests step: passed, failed with the exit code, and grey 'Tests not run' with the reason, never ok", () => {
    assert.deepEqual(step(finished(PASSED), "tests"), { key: "tests", label: "Tests passed", tone: "ok", detail: undefined });
    assert.deepEqual(step(finished(FAILED), "tests"), { key: "tests", label: "Tests failed", tone: "fail", detail: "exit 1" });
    assert.deepEqual(step(finished(SKIPPED), "tests"), { key: "tests", label: "Tests not run", tone: "skip", detail: "no tests found" });
  });
  test("four steps in order; the sandbox step shows the startup time; the patch counts lines", () => {
    const v = finished(PASSED);
    assert.deepEqual(railSteps(v).map((s) => s.key), ["sandbox", "agent", "tests", "patch"]);
    assert.equal(step(v, "sandbox").hero, "1.5 s");
    assert.deepEqual(step(v, "patch"), { key: "patch", label: "Patch ready", tone: "ok", detail: "+1 −1" });
  });
  test("before anything happens every step is pending; a finished run with no test result marks tests as failed", () => {
    assert.ok(railSteps(play([])).every((s) => s.tone === "pending"));
    const noTest = play([{ type: "sandbox_resuming", ts: 1 }, { type: "sandbox_ready", ts: 2, startupMs: 1 }, { type: "reasoning", ts: 3, text: "x" }, { type: "done", ts: 4, exitCode: 1 }]);
    assert.equal(step(noTest, "tests").tone, "fail");
  });
});
```
(`play` already exists in `run-view.test.ts`. Reuse it. Check the patch-detail characters against `RunRail.tsx:32`, which uses a real minus sign.)

- [ ] **Step 3: Red run**

Run: `node --test tests/unit/event-parser.test.ts tests/unit/run-controller.test.ts tests/unit/run-view.test.ts`. Expected `AssertionError`s:
- the parser drops `skipped` and says "tests passed";
- `testTone` always returns "ok";
- `railSteps` returns `[]`, so the `step()` helper's `assert.ok` fails.
- The reducer test fails on the missing `skipped`.

**The run-controller tests are expected to PASS already** (the outcome rule is unchanged by design). Report that explicitly as "characterisation tests, green before and after".

- [ ] **Step 4: GATE: "tests approved"**

- [ ] **Step 5: Implement**

```ts
// api/types.ts
  | { type: "test_result"; ts: number; exitCode: number; summary: string; skipped?: string }
```

```ts
// api/event-parser.ts
    else if (j.type === "test_result") {
      const exitCode = Number(j.exitCode);
      // A reason only counts with exit 0: a failure is always a failure.
      const skipped = exitCode === 0 && typeof j.skipped === "string" && j.skipped.trim() ? j.skipped.slice(0, 200) : undefined;
      const summary = skipped ? `tests not run: ${skipped}` : exitCode === 0 ? "tests passed" : `tests failed (exit ${exitCode})`;
      out.push({ type: "test_result", ts, exitCode, summary, ...(skipped ? { skipped } : {}) });
    }
```

`web/src/run-view.ts`:
- Set `test?: { exitCode: number; summary: string; skipped?: string };`.
- The reducer case becomes `v.test = { exitCode: e.exitCode, summary: e.summary, ...(e.skipped ? { skipped: e.skipped } : {}) };`.
- Move `Tone`, `Step` and `railSteps` here **verbatim** from `RunRail.tsx:3-34`, with `Tone` widened to include `"skip"` and the `tests` step changed to:
```ts
  const tests: Step = !v.test
    ? { key: "tests", label: "Tests", tone: agentDone ? "fail" : "pending" }
    : v.test.skipped
      ? { key: "tests", label: "Tests not run", tone: "skip", detail: v.test.skipped }
      : { key: "tests", label: v.test.exitCode === 0 ? "Tests passed" : "Tests failed", tone: v.test.exitCode === 0 ? "ok" : "fail", detail: v.test.exitCode === 0 ? undefined : `exit ${v.test.exitCode}` };
```
- Add:
```ts
export function testTone(t: RunView["test"]): "ok" | "fail" | "skip" {
  return t?.skipped ? "skip" : t?.exitCode === 0 ? "ok" : "fail";
}
```

`web/src/RunRail.tsx`: delete lines 3-34 and change the import to `import { railSteps } from "./run-view.ts";`.

- [ ] **Step 6: Green run.** Run `npm test` and `npm run web:build` (the build proves the moved code still type-checks in the UI bundle).

- [ ] **Step 7: Commit** `feat: test_result carries a skipped reason; grey 'Tests not run' rail step (railSteps moved to run-view.ts)`

---

### Task 6: UI: Test command field, grey tone

The only files here are markup and CSS. The logic they show is tested in Tasks 4 and 5, so this task has no new unit tests. It is verified by the build and a free browser check.

**Files:**
- Modify: `web/src/RunForm.tsx`
- Modify: `web/src/TracePanels.tsx:36`
- Modify: `web/src/styles.css`. The `.runform` grid is on line 38 and `.field.task` on line 41. The rail tones are near lines 66-69 and the badges near lines 82-83.

- [ ] **Step 1: RunForm**

```tsx
  const [testCommand, setTestCommand] = useState("");
  ...
    onSubmit({ repoUrl: repoUrl.trim(), task: task.trim(), ...(model.trim() ? { model: model.trim() } : {}), ...(testCommand.trim() ? { testCommand: testCommand.trim() } : {}) });
  ...
      <label className="field tests">
        <span>Test command</span>
        <input value={testCommand} onChange={(e) => setTestCommand(e.target.value)} spellCheck={false} maxLength={500} placeholder="auto-detect (or type skip)" />
      </label>
```
Place this field right after the Model field.

- [ ] **Step 2: Badge**

In `TracePanels.tsx`, change `className={`badge ${view.test.exitCode === 0 ? "ok" : "fail"}`}` to `className={`badge ${testTone(view.test)}`}` and import `testTone` from `./run-view.ts`.

- [ ] **Step 3: CSS**

```css
.runform { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) auto; gap: 12px 16px; align-items: end; }
.field.task { grid-column: 1 / 4; }
.rail .step.skip .node { border-color: var(--mute); background: var(--mute); }
.rail .step.skip .label { color: var(--mute); }
.badge.skip { color: var(--mute); }
```
The existing `@media (max-width: 980px)` rule already collapses `.runform` to one column and resets `.field.task`.

- [ ] **Step 4: Build and free browser check (no AWS)**

```bash
npm run web:build && npm test
HARNESS_DEMO=1 node api/main.ts   # run_in_background; demo mode starts no AWS client
```
In the built-in browser, open `http://127.0.0.1:3000` and switch to the Live run tab. Check:
- the Test command field shows with its placeholder;
- the form layout holds at desktop width and at 375 px (`resize_window` preset mobile, then reset it to desktop);
- there is no horizontal scroll.

Stop the server: `netstat -ano | grep :3000 | grep LISTEN`, then `taskkill //F //PID <pid>`.
Not checkable here: the grey rail step itself, because demo mode cannot run a real task. That is checked in Task 8.

- [ ] **Step 5: Commit** `feat: Test command field in the run form; grey style for tests not run`

---

### Task 7: Docs, then push the code

**Files:**
- `README.md`. Add a new subsection "Test command" under "Run it yourself", after line 164. It covers:
  - blank, `skip`, or a custom command;
  - the detection order;
  - the 180 s install limit;
  - that a skipped step is grey and still pushable;
  - that the image now has python3 and pytest.
  
  Also update the "How it works" mention of "runs its tests".
- `docs/DECISION_LOG.md`. Add a new entry, "Per-run test command: detected inside the VM". It records:
  - why detection happens in the VM (the repo exists only there);
  - PHP kept byte-identical;
  - skipped counts as exit 0, never green;
  - D1, D2, D3 and D4 as decided;
  - user commands have the same trust as the task text.
- `docs/EXPLAINED.md`:
  - §3 step 6: the test command is detected or given;
  - §3 step 11: the outcome rule, with skipped counting as exit 0;
  - §4: add `detect-tests.mjs` to the runner file list;
  - §4 and §9: the test counts (use the real number from `npm test`).

- [ ] **Step 1:** Write the docs. Use only numbers measured by `npm test`, and claim no real-run results yet.
- [ ] **Step 2:** `npm test` and `npm run web:build` both green.
- [ ] **Step 3:** Commit `docs: per-run test command (README, decision log, EXPLAINED)`.
- [ ] **Step 4: Scan everything that is about to be pushed.**
  ```bash
  git diff origin/main..HEAD | grep -nE 'sk-or-|github_pat_|AKIA|[0-9]{12}|@my\.|@gmail|C:\\\\Users|C:/Users' || echo "scan clean"
  ```
  Also look at every matching line by eye. A test token such as `github_pat_11ROUTETOKEN...` or the fixture ARN `111122223333` is a known fake; say so in the report.
- [ ] **Step 5:** Push with `git push origin main` (a public push; this plan covers it because the user asked for pushes after scanning). Then `gh run watch` and report the CI result on Ubuntu and Windows.

---

### Task 8: Rollout (real AWS, each step its own [go])

Preconditions: Tasks 1-7 are done, CI is green, and nothing is running (`node scripts/kill-all.ts` dry run shows no MicroVMs).

- [ ] **Step 0 (free, read-only): find the build inputs.**
  ```bash
  aws sts get-caller-identity --profile kumpas-harness --query Account --output text
  ```
  This gives the account id. Use it only in shell variables, and never write it into a committed file.
  - Bucket: `hq-smoke-microvm-<account-id>-us-east-1`.
  - Role: `arn:aws:iam::<account-id>:role/hq-smoke-microvm-build`.
  - If the narrow user cannot read either, ask the user. Do not guess.

- [ ] **Step 1 [go]: rebuild the image.**
  ```powershell
  $env:AWS_PROFILE = "kumpas-harness"
  $env:SMOKE_BUCKET = "hq-smoke-microvm-<account-id>-us-east-1"
  $env:SMOKE_BUILD_ROLE_ARN = "arn:aws:iam::<account-id>:role/hq-smoke-microvm-build"
  npm run smoke
  ```
  In the Bash tool, run it as `AWS_PROFILE=kumpas-harness SMOKE_BUCKET=... SMOKE_BUILD_ROLE_ARN=... npm run smoke` with `run_in_background`, because it takes longer than 2 minutes.
  - **Cost:** cents. That covers about 3 minutes of image build (the build cost itself was never measured), a tiny S3 upload, and the smoke run's one hospital-queue run (about 16 s of a 2 GB MicroVM plus about $0.002 of model).
  - **Expected:**
    - the image reaches `CREATED`;
    - the smoke run's `test_result` is exit 0, because PHP is detected for hospital-queue with no `TEST_CMD`;
    - the gate passes.
  - **Stop conditions:**
    - The build fails at the pip or pytest line. For example, the system Python may refuse a global install, so read CloudWatch `/aws/lambda-microvms/<image-name>`. Report it, propose a fix (for example a venv, or D1 option B), and get a new go.
    - The smoke `test_result` is not 0.
  - Record the new image name and ARN in the session only. The ARN contains the account id, so it never goes into a committed file.

- [ ] **Step 2 [go]: regression run on `jyvnn/hospital-queue` through the control plane.**
  ```powershell
  $env:AWS_PROFILE = "kumpas-harness"; $env:MICROVM_IMAGE_ARN = "<new image arn>"; npm start
  ```
  (The process env wins over `.env`, see `api/main.ts:19`.) In the built-in browser:
  - use the default repo and task;
  - leave **Test command blank**;
  - press Run task.
  - **Cost:** about $0.002 of model plus about 20 s of a MicroVM.
  - **Expected:**
    - the run ends `done`;
    - the rail shows green "Tests passed";
    - the Terminal badge says "tests passed";
    - the diff is only the comment in `app/Services/QueueEventLog.php`.
  - Do **not** press Push to branch.
  - Record the run id, startup time and total time.

- [ ] **Step 3 [go]: one run on `johnsiega/goats-hsw-rag-chatbot`.** Same server.
  - Repo: `https://github.com/johnsiega/goats-hsw-rag-chatbot`.
  - Task: `Add a one-line comment at the top of app.py that says what the file does. Do not change any behavior.`
  - Test command: blank.
  - **Cost:** the same as Step 2.
  - **Expected:**
    - the run ends `done` (green status);
    - the rail shows the grey **Tests not run** step with "no tests found";
    - the Terminal badge is grey and says "tests not run: no tests found";
    - the diff touches only `app.py`;
    - nothing is red from a missing `composer.json`.
  - Do not push.

- [ ] **Step 4 (free):** run `node scripts/kill-all.ts` (dry run). It must list no running MicroVMs. Then stop the server (netstat, then taskkill).

- [ ] **Step 5: record the results.**
  - `docs/VALIDATION.md` gets a new section "Per-run test command (measured)". It holds the two runs: date, repo, outcome, test step, startup and total time, run ids. It also records the smoke run's own result and the image name. Also add the honest gaps below to §10.
  - In README "What to know", add one line: other languages are not detected.
  - Update the auto-memory with the new image name.
  - Commit, scan as in Task 7 Step 4, push, `gh run watch`, report.

- [ ] **Step 6 (optional) [go]: delete the previous image `hq-smoke-1795435760936`.** Do this only after Steps 2 and 3 are green.
  ```bash
  aws lambda-microvms delete-microvm-image --image-identifier <old image arn> --profile kumpas-harness --region us-east-1
  ```
  It is free, and it **cannot be undone**. The S3 zip stays; removing it is the owner's job.

---

## What this plan does NOT verify (to be stated in VALIDATION.md)

- **The Node and Python paths for real.** They are tested only with fake `npm`, `python3` and pip binaries. No real `npm ci`, `pip install` or `pytest` runs inside a MicroVM, because neither rollout repo exercises them. goats is "no tests found".
- **The 180 s limit against a real slow install.** It is unit-tested at 1 s with a sleeping stub. Killing a real npm or pip process tree inside the VM is not observed.
- **The image's Python.** AL2023's `python3` version is not checked in code (it is likely 3.9). Modern `requirements.txt` files (for example numpy 2.x or torch) may not install on it. Those runs would show "dependencies could not be installed", not test results.
- **`pytest` exit code 5** (no tests collected) ends **red**, and is not special-cased.
- **A PHP repo with `composer.json` but no phpunit** ends **red** (`vendor/bin/phpunit` is missing). That is the spec's chosen behaviour.
- **A custom command and `skip`** are verified only by unit and script tests, not in a real VM.
- **Artifacts the agent itself creates** (for example, Codex running `npm install` during its turn) can still reach the diff. The D2 snapshot only excludes what the *test step* creates.
- **The Windows `timeout` behaviour** is covered by CI on Windows, but only against the stub.
- **The UI** is checked only in the built-in browser: the form in demo mode, and the rail and badge in the two real runs. No other browsers.

## Self-review (done while writing)

- **Spec coverage.** Form box → Task 6. `POST /runs` validation → Task 4. Start request → Tasks 3-4. Detection order and PHP exact match → Task 1. 180 s → Task 2. Skipped outcome, event and UI → Tasks 2 and 5. "Detection crash never fails the run" → Task 2. Each test group listed in the spec → Tasks 1-5. Rollout steps 1-4 → Task 8.
- **Deliberate deviations, all flagged above:**
  - D1 (pytest in the image);
  - D2 (diff snapshot before tests);
  - D3 (case-insensitive `skip` and its reason text);
  - `python3 -m pip` instead of bare `pip`, because pip may not be on PATH while `python3` is.
- **Names used across tasks:** `detectTests`, `formatPlan`, `TEST_CMD`, `TEST_INSTALL_TIMEOUT`, `testCommand`, `skipped`, `railSteps`, `testTone`, `Tone`, `Step`.
