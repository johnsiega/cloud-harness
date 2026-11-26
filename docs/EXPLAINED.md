# Throwbox, explained

A guided tour of this project, written so you can learn all of it and explain it to someone else. It is long on purpose. Read it in order the first time, then use the headings to look things up.

Everything here is checked against the code and the measurements in this repository. Where something was **not** verified, it says so. For the numbers and their sources, the authority is [`VALIDATION.md`](VALIDATION.md); for each design choice and its evidence, [`DECISION_LOG.md`](DECISION_LOG.md).

---

## 1. The idea in one minute

You give the system a public GitHub repository and a task in plain words ("add a comment above this method"). It:

1. starts a **brand-new, isolated virtual machine** on AWS,
2. lets an **AI coding agent** (Codex CLI) clone the repo, change the code and run the project's tests inside that machine,
3. sends the agent's thoughts, commands and the resulting **diff** to your browser **live**,
4. throws the machine away when the run ends,
5. and, if you approve, **pushes the change to a branch** of a private repository.

**Why bother?** An AI agent that writes and runs code is risky to run on your own laptop: it can read your files, use your credentials and reach your network. A disposable VM that starts in about two seconds changes that trade-off. This project is a working prototype of that idea, with the speed, limits and risks actually measured.

**Analogy.** Think of a hotel room that is built for one guest, cleaned to nothing when they leave, and that the guest can only leave a note from. The agent is the guest; the diff is the note; you decide whether the note gets delivered.

---

## 2. Vocabulary you need

| Term | Plain meaning |
|---|---|
| **MicroVM / Firecracker** | A very small, fast virtual machine. Firecracker is the open-source technology AWS built to start them in a fraction of a second while keeping each one strongly isolated from the others. |
| **AWS Lambda MicroVMs** | The AWS service this project uses to launch those VMs from a **prebuilt image** (like a saved disk with Node, PHP, Composer, git and Codex already installed). |
| **Image** | The prebuilt template. Building one takes about three minutes; starting a VM from it takes about two seconds. |
| **Control plane** | The program that sits outside the VMs and manages them: it starts them, talks to them, streams results to the browser and cleans up. Here it is a small Hono server on your own machine (`127.0.0.1:3000`). |
| **Sandbox** | The VM the agent works in. |
| **Codex CLI** | OpenAI's command-line coding agent, run headless (no screen) inside the VM. |
| **OpenRouter** | A service that gives one API for many AI models. The agent calls the model through it. |
| **Model** | The AI itself. Default: `deepseek/deepseek-v4.1-flash`, chosen because it got 5 of 5 correct diffs in a test of four models (see §9). |
| **SSE (server-sent events)** | A simple way for a server to push a stream of messages to a browser over one HTTP connection. Each message is `event: <type>` then `data: <json>`. |
| **Diff** | The exact lines added and removed, in the standard `git diff` format. |
| **Run hook** | A feature of Lambda MicroVMs: when a VM is started you can pass it a payload (up to 16 KB) that is delivered to a hook inside it. This is how the API key and task get in. |
| **Quota** | A limit AWS puts on your account. Here it is *memory* across all MicroVMs, not a count of VMs. |
| **TDD (test-driven development)** | Write the tests first, watch them fail, then write the code that makes them pass. This project did that for every piece of code. |
| **Redaction** | Replacing secrets in text with `[REDACTED]` before it is stored or shown. |

---

## 3. The life of one run, step by step

This is the single most useful section. Follow one run from click to branch.

```
Browser ──► Control plane ──► AWS Lambda MicroVM ──► Codex CLI ──► model (via OpenRouter)
 (React)    (Hono, 127.0.0.1)   (Firecracker VM)         │
    ▲             │                                      ▼
    │             │            clone ─► edit ─► run tests ─► git diff
    └── live events (SSE) ◄── polls the VM every 0.5 s ◄── results
```

1. **You press "Run task".** The page `POST`s `{ repoUrl, task }` to `/runs` (`web/src/useRun.ts`, `api/server.ts`).
2. **The control plane validates it.** Only `https://github.com/<owner>/<repo>` URLs, a sane model id, and a payload under 16 KB are accepted (`validate()` in `api/server.ts`, reusing `buildRunRequest` from `scripts/smoke-test.ts`). A second identical request while the first is still active gets 409.
3. **A run record is created** in an in-memory store (`api/run-store.ts`), and `executeRun` starts in the background (`api/run-controller.ts`). The page gets an id and opens an `EventSource` on `/runs/<id>/stream`.
4. **The launcher starts a MicroVM** (`api/microvm-launcher.ts`, `api/aws-microvms.ts`): it calls AWS `RunMicrovm` with the image, the network connectors, and a **run hook payload** containing the OpenRouter key and model. It creates an access token, then probes `https://<endpoint>/health` every 250 ms until the VM answers. That time is the "Sandbox ready" number (typically 1.3 to 2.4 s).
5. **The control plane tells the VM to start the task** (`POST /` with `{ repoUrl, task }`, plus `testCommand` when you typed one). Inside the VM a small HTTP server, the **runner** (`scripts/runner/server.mjs`), starts `run-task.sh`.
6. **`run-task.sh` does the work:** `git clone`, records the base commit, runs `codex exec` with the task, captures `git diff --binary`, then runs the tests: the command you typed, or one detected by `detect-tests.mjs` (PHP, Node or Python), or nothing ("tests not run", with a reason). Taking the diff first keeps `node_modules` and test caches out of the patch. Everything it prints is JSON lines plus a `__DIFF_START__ … __DIFF_END__` block.
7. **The control plane polls the VM** (`GET /events?since=N`) every 500 ms. Lambda MicroVMs have no stdout or exit-code API, so polling the runner is the only way out (decision: "Event transport").
8. **The event parser** (`api/event-parser.ts`) turns that raw output into a small set of typed events: `sandbox_resuming`, `sandbox_ready`, `reasoning`, `stdout`, `stderr`, `test_result`, `diff`, `done`. It is careful with partial lines and markers split across chunks.
9. **Every event is redacted** (`api/redact.ts`), stored, and streamed to the browser as SSE (`api/sse.ts`).
10. **The browser renders it** with a pure reducer (`web/src/run-view.ts`) into three panels (Reasoning, Terminal, Diff) and a four-step progress rail.
11. **The outcome is decided.** A run is `error` if the tests exit non-zero, Codex exits non-zero, or the diff is empty. Otherwise `done`. A test step that was not run counts as exit 0 (so it cannot turn a good diff red) but is shown as a grey "Tests not run" with its reason, never green.
12. **The VM is terminated, always** (`finally` in `executeRun`), even if something failed.
13. **If you press "Push to branch" (or, for a repo in `PR_REPOS`, "Open draft PR"):** the control plane clones the source repo fresh at the **exact base commit**, applies the diff, commits as "Cloud harness" and pushes `harness/<runId>` to the private repo (`api/patch-delivery.ts`). The VM is already gone and never sees the GitHub token. The PR button does the same push into the run's own repo with a separate token, then opens a **draft** pull request through the GitHub API (`api/github-pr.ts`).

---

## 4. Map of the code

### `api/` (the control plane, runs on your machine)
| File | Job |
|---|---|
| `main.ts` | Entry point. Reads `.env`, picks real or demo mode, wires everything, serves the built UI. |
| `mode.ts` | Decides real vs demo from the environment (missing key/image, or `HARNESS_DEMO=1`). |
| `server.ts` | The Hono routes: `/runs`, `/runs/:id`, `/runs/:id/stream`, `/runs/:id/push`, `/runs/:id/pr`, `/config`, and the demo-mode 503 guard. |
| `request-guard.ts` | Rejects cross-site and DNS-rebinding requests (see §6). |
| `run-controller.ts` | One run, start to finish: launch, poll, parse, decide outcome, always terminate. |
| `microvm-launcher.ts` | Launches a VM and talks to the runner. Every runner call has a 30 s deadline. |
| `aws-microvms.ts` | The thin real AWS layer (SDK calls). Injectable, so tests use a fake. |
| `event-parser.ts` | Runner output to typed events. |
| `redact.ts` | Secret scrubbing. |
| `run-store.ts` | In-memory records with a one-hour TTL. |
| `sse.ts` | Formats SSE frames safely (a multi-line diff stays on one `data:` line). |
| `patch-delivery.ts` | The safe branch push. |
| `github-pr.ts` | The GitHub REST client for draft PRs (injected `fetch`, fixed error messages) and the PR title and body builders. |
| `repo-allowlist.ts` | `PR_REPOS` parsing and exact owner/repo matching, shared by the server and the UI. |
| `simulation.ts`, `simulate-routes.ts` | The seeded 100-run simulation and its endpoints. |
| `quota.ts` | Recognises AWS's "memory limit reached" refusal. |
| `types.ts` | The shared data contracts and test seams. |

### `web/src/` (the React UI)
`App.tsx` (tabs), `RunForm`, `RunRail`, `TracePanels`, `SimulationView`, plus pure logic that has the unit tests: `run-view.ts` (state for one run), `simulation-view.ts` (state for 100 runs, summary, per-frame batching), `push-state.ts`. Hooks `useRun`, `useSimulation`, `usePush` connect them to the network.

### `scripts/`
- `runner/` (`server.mjs`, `run-task.sh`, `detect-tests.mjs`, `Dockerfile`): what runs **inside** the VM.
- `smoke-test.ts`: builds the image (via the AWS CLI), runs smoke tests and compares models.
- `measure-startup.ts`: cold vs warm start measurement.
- `kill-all.ts`: emergency stop for every MicroVM (dry run by default).
- `load-real.ts`: stepped real concurrency test.

### `tests/` and CI
624 tests (618 pass, 6 skipped, the real-AWS integration tests, which only run with `RUN_INTEGRATION=1`). Tests live in `tests/unit`, `tests/simulation`, `tests/integration`, plus `scripts/*.test.ts`. CI (`.github/workflows/ci.yml`) runs the tests and the UI build on Ubuntu and Windows with no secrets and read-only permissions.

---

## 5. Key concepts, in depth

### 5.1 Why a separate control plane at all?
The browser must never hold AWS credentials, the OpenRouter key or the GitHub token. The control plane is the only place that does. It is also the only thing that can keep running after you close the tab, and the only reliable place to terminate the VM.

### 5.2 Why polling instead of streaming from the VM?
Lambda MicroVMs expose no stdout and no exit-code API. The alternatives were CloudWatch Logs (adds delay and another moving part) or the runner buffering events and the control plane polling it. The runner approach was chosen. **Cost:** about 500 ms granularity, so "first output" is a polled time, not a true streamed one.

### 5.3 How the API key travels
Environment variables are set at **image build** time and shared by every VM from that image; putting the key there would bake it into the snapshot. So the key goes only in the **run hook payload**, per run. Tests assert it never appears in a URL, header or runner request body, and redaction removes it from everything stored or streamed. Optionally (`OPENROUTER_MANAGEMENT_KEY`), the control plane creates a capped, 30-minute key for each run, sends only that one, and deletes it when the VM is terminated (`api/openrouter-keys.ts`).

### 5.4 Why the push is done by the control plane, after the VM is gone
The GitHub token must never enter the sandbox (the agent has open internet access and could leak it). So the control plane re-creates the change itself: fresh clone at the exact base commit, `git apply --cached --binary`, commit, push a new branch. It never forces, never touches `main`, one push per run, and the token travels only in `GIT_CONFIG_*` environment variables on the two git calls that talk to the target, never in an argument or URL.

### 5.5 SSE and why the diff is safe
SSE frames are separated by a blank line. If a diff contained `\n\nevent: done`, a naive server could let model output forge an event. `formatSse` uses `JSON.stringify`, which escapes newlines, so every event is exactly one `data:` line. A test feeds it hostile text.

### 5.6 The quota: memory, not a count
AWS limits **memory across all MicroVMs** (running **and suspended**). The default in `us-east-1` is 2,048 GB, but new accounts get a reduced limit. This account's applied value is **8 GB** (from the Service Quotas console), and a run needs the 2 GB baseline, so **at most 4 real runs fit at once**. That is why the "100 agents" view is a simulation.

---

## 6. Security, and the bug that shaped it

**The cross-site bug.** Binding to `127.0.0.1` sounds safe, but a web page open in your browser can still send requests to `http://127.0.0.1:3000`. In testing, a cross-origin `text/plain` POST **started a MicroVM** (HTTP 202) on the owner's AWS account. The fix (`api/request-guard.ts`): every request needs a loopback `Host` (stops DNS rebinding), an `Origin` that matches `Host` if present (stops cross-site), and `application/json` on POST (a type a browser cannot send cross-site without a CORS preflight, which is never granted). This was done before a write token existed.

**Defence list**
- Loopback-only binding plus the guard above.
- Request validation (GitHub-only URLs, bounded sizes).
- Redaction of keys and token-shaped strings in stored and streamed data.
- GitHub token kept in the control plane; git runs with prompts, credential helpers, global config and every non-HTTPS protocol off.
- A narrowly scoped AWS user (MicroVM actions, one bucket, one build role).
- Simulated runs can never be pushed: they never enter the store.

**Honest limits (also in the README's Data boundaries)**
- Your repo's code and the task go to OpenRouter and the model provider behind it.
- The sandbox has open internet access.
- The OpenRouter key **is inside the VM while a run goes** (Codex needs it), so a malicious repo could read and send it. Use a capped, disposable key and rotate it after running untrusted code.
- Redaction does not catch a transformed copy of a secret (for example an encoded one).

---

## 7. The simulation and demo mode

**Why it exists.** The original goal said "100+ concurrent agents". Real mode is capped at 4 by the quota, so a UI test at 100 needs synthetic data.

**How it works.** `POST /simulate?n=100` creates a seeded plan (`api/simulation.ts`): jittered starts over 3 s, startup 1.3 to 2.4 s (the measured range), run time 15 to 50 s, about 10% failures. `GET /simulate/:id/stream` sends **all** runs over **one** SSE connection, every frame tagged with `runId` and `simulated: true`, then a `simulation_done` event. After it ends, the id answers 204 so the browser's automatic reconnect stops instead of replaying 100 runs.

**Two things it guarantees**
- It never touches the store, launcher or push (a test asserts the real machinery is never called).
- All 100 runs are alive together for a window (a generator test proves it, and the browser check saw 100 in progress at once).

**Demo mode.** With no key or image (or `HARNESS_DEMO=1`), the server starts with no AWS client at all, real runs and pushes answer 503 with how to enable them, and the UI opens on the Simulation tab. Anyone can clone the repo and see it work.

**In the UI.** `web/src/simulation-view.ts` keeps one `RunView` per run; only the run that received an event gets a new object, so React can skip the other 99 tiles. Updates are batched once per animation frame (`createBatcher`), so 900 events do not mean 900 renders. (A side effect found during testing: when the browser pane is hidden, animation frames pause and rendering catches up when it is shown. No data is lost.)

---

## 8. How it was built: test-first with gates

The rule for every code step:
1. Write the tests and a stub (empty implementation).
2. Run them **red**, and make sure every failure is a real assertion (not a crash or a vacuous pass).
3. A human reviews the tests and says "tests approved".
4. Only then write the implementation, until green.

Steps that spend money or publish (every real-AWS run, the release, deletions) also needed a separate explicit "go". Every push went to a **public** repo, so each commit was scanned for secrets and personal data first.

Why this matters: it forces you to say what "correct" means before writing code, and it caught real mistakes, for example tests that passed against an empty stub, and a test helper that crashed instead of failing.

**A good habit to copy:** inject the things that touch the outside world (AWS, fetch, the clock, timers, sleep) so tests can replace them. The 100-run simulation tests finish instantly because the scheduler is injected.

---

## 9. What was measured (short version)

Full tables, samples and sources are in [`VALIDATION.md`](VALIDATION.md). Highlights, all small samples from one Windows machine to `us-east-1`:

| Result | Value |
|---|---|
| VM ready from the image (call to first healthy response) | median 1.9 s, p95 2.3 s, n=20 |
| Resume from suspend | median 1.8 s, n=20, **not faster** than a cold start, so no warm pool was built |
| Real runs at once | **4** succeeded (K=2, 3, 4); the 5th VM was refused by the 8 GB memory limit |
| A real run (13 runs, started 2 to 5 at a time) | first output median 6.8 s, total median 15.4 s |
| 100 concurrent runs | **simulated**; the browser showed 100 in progress at once |
| Tests | 624 (618 pass, 6 skipped), green on Ubuntu and Windows |

**Reading the numbers correctly**
- "Ready" excludes repo clone and model time, which dominate a real run.
- "First output" is the first agent message, not a "first reasoning token" (Codex emits no reasoning items).
- A p95 over 4 or 20 samples is just the second-largest or largest value.
- A pre-set decision rule ended the warm-pool idea: it needed at least 30% and 500 ms faster, and got about 120 ms. Deciding the rule *before* measuring is what makes that an honest result.

**Model comparison (Phase 0, 5 runs each):** deepseek-v4.1-flash 5/5, particle-1 5/5, qwen3-coder 4/5, qwen3-coder-30b 2/5. The raw per-run files were not kept, so this table rests on the decision log's notes.

---

## 10. Things that went wrong (the learning is here)

| Problem | What happened and the lesson |
|---|---|
| **Cross-site request started a VM** | `127.0.0.1` is not a security boundary against the browser. Add Host/Origin/content-type checks. |
| **Run hook not firing** | Without `--hooks` (run hook enabled) at image build, the VM never receives its payload. Read the platform's lifecycle rules. |
| **Codex `wire_api` mismatch** | Codex 0.171 rejected `"chat"`; `"responses"` worked with OpenRouter. Pin and verify tool versions. |
| **Windows tooling** | Git Bash `tar` broke zips; a Node `devNull` path broke git on Windows. Test on the OS you ship for (CI now covers Ubuntu and Windows). |
| **Fresh Laravel clone failed tests** | No `APP_KEY`, so a test died. The runner exports a throwaway key. |
| **A fifth VM refused** | The quota is memory and counts suspended VMs. Measure the limit, don't assume it. |
| **Warm start didn't help** | The data killed an idea that sounded great. Measure first. |
| **Mislabelled quota stop** | AWS's refusal said "maximum allocated memory", not "quota", so a string match missed it. Fixed with a shared helper and tests; the raw data kept its original label. |
| **Hidden browser pane** | Animation frames pause when hidden, so my first timing was misleading. Check the tool's state before trusting a measurement. |
| **Timeout not exercised for real** | When a VM was killed mid-run the next poll returned a fast 502, so the 30 s timeout was only tested in unit tests. Say what was *not* verified. |

---

## 11. Commands cheat sheet (PowerShell)

```powershell
npm install
npm test                      # 624 tests, no AWS needed
npm run web:build             # build the UI
npm start                     # real mode if keys/image set, otherwise demo mode
$env:HARNESS_DEMO = "1"; npm start   # force demo mode

# Real mode needs: AWS_PROFILE, MICROVM_IMAGE_ARN, and OPENROUTER_API_KEY in .env
node scripts/kill-all.ts        # dry run: list every MicroVM
node scripts/kill-all.ts --yes  # terminate them
node scripts/load-real.ts       # stepped real load test (spends money)
npm run test:integration        # one real MicroVM (RUN_INTEGRATION=1, spends a few cents)
```

---

## 12. Can you put this on your resume?

**Yes, as long as every claim matches what was actually proven and you can explain it.** The project is real, public, tested and honest about its limits, which is itself a strength.

### Strong, accurate bullets (pick three or four)
- Built a **control plane (TypeScript, Hono, React)** that runs an AI coding agent in a **disposable AWS Lambda MicroVM** per task and streams its reasoning, terminal output and diff live over **server-sent events**; a human-approved diff can be pushed to a branch of a private repo.
- Measured **MicroVM startup (median 1.9 s over 20 runs)** and **resume (1.8 s)**, set a decision gate in advance, and **declined to build a warm pool** when the data failed it.
- Ran **up to 4 concurrent real agent runs** and diagnosed the account's **8 GB MicroVM memory quota** as the limit; built a **seeded 100-run simulated load view** (one SSE connection, per-frame batching) to test the UI at scale, clearly labelled as simulated.
- Found and fixed a **cross-site request vulnerability** (a web page could start a VM through a localhost API) with Host/Origin/content-type checks; kept API and GitHub tokens out of logs and out of the sandbox.
- Delivered **624 automated tests, built test-first**, with CI on Ubuntu and Windows, plus a validation document where every number has its sample size, date and source.

### Claims to avoid or qualify
- ❌ "Runs 100+ concurrent agents." ✅ "Renders 100 **simulated** concurrent runs; real mode tested to 4 under the account quota."
- ❌ "Sub-5-second agent startup." ✅ "MicroVM ready in about 2 s (excludes repo clone and model time)."
- ❌ "Production system" or "hosted". ✅ "Prototype you run against your own AWS account."
- ❌ "First reasoning token under N seconds." The metric is the first agent message.
- Say it was **built with AI assistance** (Claude Code). The README already says so, and recruiters respect honesty. What matters is that you can explain the design, so use this guide.

### Where to link
The GitHub repo (`johnsiega/throwbox`), with the README screenshot and `docs/VALIDATION.md`. Consider adding a repository description and topics (for example `aws-lambda`, `microvm`, `ai-agents`, `sse`, `typescript`, `hono`) and pinning it to your profile.

### Likely interview questions, with answers you can give
1. **Why a MicroVM instead of Docker?** A MicroVM has its own kernel and strong hardware-level isolation, which matters when running untrusted AI-written code; it still starts in about two seconds.
2. **How do you stream results from a VM with no stdout API?** A small runner inside the VM buffers events; the control plane polls it every 500 ms and re-streams over SSE. The trade-off is 500 ms granularity.
3. **How do you keep secrets safe?** The key travels only in the per-run payload, never in the image; redaction scrubs everything stored or streamed; the GitHub token never enters the VM because the control plane applies and pushes the diff itself. The honest limit: the key is inside the VM during a run, so use a capped key.
4. **What was the hardest bug?** The cross-site POST that started a VM from a web page, and why `127.0.0.1` binding is not enough.
5. **Why didn't you build the warm pool?** I set a bar of at least 30% and 500 ms faster before measuring; resume was about 120 ms faster. The data said no.
6. **How did you test 100 concurrent agents?** I didn't, for real: the account's memory quota allows 4. I built a labelled simulation and tested real concurrency to 4, and documented the gap.
7. **What would you do next?** Raise the quota and test 10 to 20 real VMs; pre-clone the repo in a pooled VM (where most run time goes); add auth and hosting; keep the raw model-comparison data.

---

## 13. Honest gaps (also listed in `VALIDATION.md` section 10)

Not tested: real mode at 10 to 20 MicroVMs (blocked by the quota); the poll timeout against real AWS; macOS; browsers other than the built-in one; the AWS setup on a clean account; the cost per run (AWS compute and model spend were not measured); and why the first two K=2 runs were slow (about 45 s to first output).

---

## 14. A study path

If you want to truly master it, do these in order. Each one is small.

1. Run demo mode (`npm start` with no keys) and watch the Simulation tab. Open the browser's Network tab and find the one SSE connection.
2. Read `api/sse.ts` and its test, then `api/event-parser.ts` and its test. Change a test to see it fail.
3. Read `api/run-controller.ts` top to bottom (it is about 90 lines). Trace a failure: what ends up in the store?
4. Read `api/request-guard.ts` and try to craft a request that gets through. (You should not be able to.)
5. Read `api/simulation.ts`, then `tests/unit/simulation.test.ts`: how do the tests prove "all 100 are alive at once"?
6. Read `web/src/simulation-view.ts`: why does only one tile get a new object per event?
7. Read `api/patch-delivery.ts` and its tests: why clone at the *base* commit?
8. Read `DECISION_LOG.md` and `VALIDATION.md` side by side, and for three numbers, find the raw file behind them in `docs/measurements/`.
9. With your own AWS account and a capped key, run one real task, then `node scripts/kill-all.ts` (dry run).
10. Explain the whole project out loud in five minutes without notes. That is the test.
