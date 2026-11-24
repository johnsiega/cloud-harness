# Cloud harness

**Watch an AI coding agent work inside a disposable cloud computer.**

Cloud harness takes a public GitHub repository and a task written in plain words, such as "add a comment above this method". It starts a fresh, isolated virtual machine on AWS, lets an AI coding agent clone the repo, change the code, and run the project's tests, then shows you the result as a diff. You watch it happen live in three panels: what the agent is thinking, what it runs, and what changed.

If you like the change, one button pushes it to a new branch in a private repository. Nothing touches your own machine, and nothing is merged for you.

For example, you can ask for "add a one-line comment above `enabled()` in `app/Services/QueueEventLog.php`" and, about twenty seconds later, see the exact one-line patch, the passing test run, and a button that puts it on a branch.

## Why we built it

AI agents write and run code. Letting one do that on your own laptop means trusting it with your files, your credentials and your network. A throwaway virtual machine that starts in seconds and is destroyed when the run ends changes that trade-off.

This project explores that idea end to end: the isolation, how fast it starts, what it costs, how to watch the agent without trusting it, and how to get its work out safely. It is a working prototype, built step by step with tests first, and it records what was measured and what was not.

## Try it

You need your own AWS account and an OpenRouter key; see [Run it yourself](#run-it-yourself). With the control plane running, open <http://127.0.0.1:3000>.

1. Keep the default repository (`https://github.com/jyvnn/hospital-queue`) or paste another **public** GitHub repo.
2. Keep the default task or write your own, then press **Run task**.
3. Watch the progress rail: **Sandbox ready**, **Agent**, **Tests**, **Patch**. The large number is how long the virtual machine took to become ready.
4. Read along. **Reasoning** shows the agent's messages, **Terminal** shows the commands it ran, and **Diff** shows the change line by line.
5. Press **Copy diff**, or **Push to branch** if you set up a push target. A pushed run shows a link to its branch. Each run can be pushed once.

## How it works

```
Browser ──► Control plane ──► AWS Lambda MicroVM ──► Codex CLI ──► AI model (OpenRouter)
  (React)     (Hono, 127.0.0.1)   (Firecracker VM)      │
     ▲              │                                    ▼
     │              │              clone ─► edit ─► run tests ─► git diff
     └── live events (SSE) ◄── polls the VM every 0.5 s ◄── results
```

- **The sandbox.** Each run gets its own AWS Lambda MicroVM, started from a prebuilt image that already contains Node, PHP, Composer, git and the Codex CLI. The VM is terminated when the run finishes.
- **The agent.** [Codex CLI](https://github.com/openai/codex) runs headless inside the VM and talks to a low-cost model through OpenRouter. The default is `deepseek/deepseek-v4.1-flash`.
- **The loop.** Clone the repo, let the agent edit, run the repo's own test command, and capture a binary-safe `git diff`.
- **The stream.** The control plane polls the VM for new events, parses them into a small set of event types, and streams them to the page over server-sent events. Every event is scrubbed for secrets first.
- **The patch.** To push, the control plane clones the repo fresh at the exact commit the sandbox started from, applies the diff, commits as "Cloud harness", and pushes `harness/<run id>`. The VM no longer exists by then, and the push token never goes near it.

## What we measured

Small samples on one machine in `us-east-1`, so treat these as indications, not benchmarks.

| What | Result |
|---|---|
| Time until the VM is ready (submit to first healthy response) | about 1.3 to 4.5 s, typically around 3.7 s |
| Time until the agent's first message | about 7 to 15 s |
| A whole run (clone, edit, install, tests, diff) | typically 15 to 50 s |
| Model cost | about a fifth of a cent per run (AWS compute cost not yet measured) |

We compared four models with five real runs each. "Correct" means one added comment directly above the right method and nothing else.

| Model | Correct diffs | Median run |
|---|---|---|
| `deepseek/deepseek-v4.1-flash` (default) | 5 of 5 | 17 s |
| `particle-ai/particle-1` | 5 of 5 | 16 s |
| `qwen/qwen3-coder` | 4 of 5 | 20 s |
| `qwen/qwen3-coder-30b-a3b-instruct` | 2 of 5 | 51 s |

The smallest model often read the file again and again and never made the edit, so we dropped it.

## Safety choices

- The control plane listens on `127.0.0.1` only. It also rejects requests whose `Host` or `Origin` isn't local, because a web page open in your browser could otherwise start runs on your AWS account.
- The OpenRouter key reaches the VM only through the run's startup payload, never through the image. It is redacted from everything stored or streamed.
- The GitHub token stays in the control plane. A push can only create a new `harness/<run id>` branch. It never forces, never touches `main`, and each run can be pushed once.
- Git runs with prompts, credential helpers, your global config and every protocol except HTTPS turned off, and the token is passed through the environment, not the command line.
- The AWS user has a narrow policy: MicroVM actions, one S3 bucket, one build role and the MicroVM logs. It cannot touch ordinary Lambda functions or IAM.

## Run it yourself

Requirements: Node.js 22.18 or newer, an AWS account with Lambda MicroVMs in `us-east-1`, the AWS CLI, and an [OpenRouter](https://openrouter.ai) API key. The commands below are for PowerShell.

**1. Install and test.** The tests need no AWS access.

```powershell
npm install
npm test
```

**2. One-time AWS setup.** You need an S3 bucket for the image package, a build role that Lambda can assume (read the bucket, write CloudWatch Logs), and an IAM user whose policy allows `lambda:*Microvm*`, `lambda:PassNetworkConnector` on the two managed network connectors, `s3:PutObject` and `s3:GetObject` on the bucket, `iam:PassRole` for the build role (to `lambda.amazonaws.com`), and reading the MicroVM log group.

**3. Add your keys.** Create a `.env` file in the repo root. It is git-ignored.

```
OPENROUTER_API_KEY=your-openrouter-key
```

**4. Build the image.** This takes about three minutes, runs one real test task, and prints the image ARN.

```powershell
$env:AWS_PROFILE = "your-profile"
$env:SMOKE_BUCKET = "your-bucket"
$env:SMOKE_BUILD_ROLE_ARN = "arn:aws:iam::<account-id>:role/<build-role>"
npm run smoke
```

**5. Build the page and start the control plane.**

```powershell
npm run web:build
$env:MICROVM_IMAGE_ARN = "<image arn printed above>"
npm start
```

Open <http://127.0.0.1:3000>. Rebuild the image whenever anything in `scripts/runner/` changes.

### Optional: push patches to a branch

Create a **private** GitHub repository that contains the same history as the repo you run against, for example a copy of its `main`. Turn GitHub Actions off in it. Create a fine-grained token limited to that one repository with **Contents: read and write**, and add two lines to `.env`:

```
GIT_PUSH_TOKEN=github_pat_...
PUSH_TARGET_URL=https://github.com/<you>/<private-repo>
```

Restart the control plane. Without a token the button is hidden.

## What to know

- This is a prototype. It runs on your own machine against your own AWS account, and there is no hosted version, login or database.
- Only **public** GitHub repositories can be cloned, and the sandbox has open internet access.
- A task changes code and runs tests. It does not judge whether the change is good, so read the diff.
- Warm starts (suspending and resuming a VM) have not been measured yet. Every number above is a start from the image. See [the Phase 4 plan](docs/PHASE_4_PLAN.md).
- The planned 100-run simulation has not been built.
- The "first reasoning token" metric isn't available, because the agent's output stream has no reasoning items. We report the first agent message instead.
- It was built and tested on Windows with Git Bash and PowerShell.

## Documentation

- [`Development_Process.md`](Development_Process.md): the full plan, with phases, the test-first rules and the completion checklist.
- [`docs/DECISION_LOG.md`](docs/DECISION_LOG.md): each design choice, the evidence behind it, and what it costs.
- [`docs/PHASE_4_PLAN.md`](docs/PHASE_4_PLAN.md): the plan for measuring and using warm starts.

## Built with

TypeScript (run directly by Node), Hono, React 19, Vite, AWS Lambda MicroVMs, the AWS SDK for JavaScript, Codex CLI, OpenRouter, and the Node test runner. The demo target is the public Laravel project [`jyvnn/hospital-queue`](https://github.com/jyvnn/hospital-queue).

## Author

John Cedrick P. Siega

## Development checks

```powershell
npm test                  # unit tests, real-git push tests, runner tests (296 pass, 1 skipped)
npm run test:integration  # one real MicroVM; costs a few cents; set RUN_INTEGRATION=1 and MICROVM_IMAGE_ARN
```

Built with assistance from Claude Code (Anthropic). The agent inside the sandbox is the OpenAI Codex CLI.
