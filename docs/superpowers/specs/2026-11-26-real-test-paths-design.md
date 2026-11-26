# Proving the untested test paths in real MicroVMs: design

Status: **approved by the owner on 2026-11-26.** Not yet implemented. Creating the two fixture repos is a public write that needs its own go.

## Problem

Piece 1 (the per-run test command) shipped with these paths tested only in unit tests with fake `npm`, `python3` and pip:
- Node detection and install;
- Python detection and install;
- a typed test command;
- `skip`.

The gaps are listed in `docs/DECISION_LOG.md` ("Per-run test command") and `docs/VALIDATION.md` section 11. Only PHP, and "no tests found", have run for real.

## Fixture repos (public, owned by the owner, each needs a go to create)

Detection checks Node before Python, so one repo cannot prove both paths. Two tiny repos:

| Repo | Files | Detected as |
|---|---|---|
| `johnsiega/throwbox-fixture-node` | `package.json` (`"test": "node --test"`, no dependencies), a `package-lock.json` with no dependencies (so `npm ci` runs, not the fallback), `math.js`, `math.test.js` | Node: `npm ci \|\| npm install`, then `npm test` |
| `johnsiega/throwbox-fixture-python` | `calc.py`, `tests/test_calc.py` (the `tests/test_*.py` evidence path, with no `pytest.ini`), a `requirements.txt` with one small pure-Python package | Python: pip install `-r requirements.txt`, then `python3 -m pytest -q` (`-m` puts the repo root on `sys.path`, so `import calc` works) |

Both repos: MIT, a README that says they are fixtures for Throwbox, no `.github/` folder (so no Actions), and nothing secret.

## The five real runs

Every task must make an edit, because a run with an empty diff ends in error. Each task is "add a one-line comment above `<function>` in `<file>`. Change nothing else."

| # | Repo | Test command | Expected |
|---|---|---|---|
| R1 | node fixture | blank | `done`, `test_result` exit 0, no `skipped`, "Tests passed" |
| R2 | python fixture | blank | `done`, exit 0, no `skipped` |
| R3 | node fixture | `node --test math.test.js` | `done`, exit 0 |
| R4 | node fixture | `SKIP` (upper case, to prove case folding) | `done`, `skipped: "skipped by request"`, grey "Tests not run" |
| R5 | node fixture | `node -e "process.exit(3)"` | `error`, `done.exitCode` 3, the diff is still shown |

They run as a new integration test file, `tests/integration/test-paths.test.ts`, through the real control plane (HTTP, then SSE), like `tests/integration/end-to-end.test.ts`. It is skipped unless `RUN_INTEGRATION=1` and `MICROVM_IMAGE_ARN` are set, which adds 5 skipped tests to `npm test`. R1 to R4 run at the same time, which is the quota's limit of 4, and R5 runs after them.

## When a run does not match

- Follow systematic debugging.
- The bug gets a failing unit test first (with a red run and "tests approved"), then the fix.
- If `scripts/runner/` changes, the image is rebuilt (its own go), and only the affected runs are repeated.
- A fixture problem, such as a bad lockfile, is fixed in the fixture repo (a public write, its own go) and recorded, not hidden.

## Recorded

Each run's status, its `test_result`, its duration and the image ARN go into `docs/measurements/test-paths.json` and VALIDATION.md (a new section). The decision log's "Gaps" line for piece 1 is updated.

## Not covered

- The 180-second install limit against a real slow install.
- Go, Rust and Java.
- A repo that has both Node and Python.
- `npm ci` failing over to `npm install`.
- Network installs for Node: the fixture has no dependencies.
- Whether pip installs work when the package is already in the image: the chosen package is meant to be absent, but that is unverified.
