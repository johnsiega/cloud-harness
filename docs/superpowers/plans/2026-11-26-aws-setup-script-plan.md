# One-command AWS setup script: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run setup:aws` shows, then (with `--yes`) creates the bucket, build role, scoped IAM user and policy, and the MicroVM image. It can be re-run safely. `--teardown` removes everything it made. It never prints or stores a secret.

**Architecture:**
- A CloudFormation template in JSON (`scripts/setup/throwbox-aws.json`) owns the bucket, role, user and policy. CloudFormation gives preview (change sets), re-runs and deletion for free.
- A thin Node script (`scripts/setup-aws.ts`) drives the AWS CLI through an injected runner, in the style of `scripts/kill-all.ts`. It adds what CloudFormation lacks: the policy text in the preview, the image build, and emptying and cleaning up before delete.
- The image build moves out of `scripts/smoke-test.ts` into an exported `buildImage()`, so both commands share it.

**Tech Stack:** Node 22 (TypeScript run directly, `node:test`), AWS CLI v2 (CloudFormation, S3, IAM, `lambda-microvms`). No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-11-26-aws-setup-script-design.md`](../specs/2026-11-26-aws-setup-script-design.md)
**Status:** spec and plan approved by the owner on 2026-11-26. Test approach: **option B** (this account, a temporary admin principal, prefix `throwbox-test`). Not yet implemented.
**Release:** v1.1.0, item 2 of 4. Independent of item 1.

## Global Constraints

- TEST FIRST: tests and a stub, then a red run with assertion-only failures. **Stop at the "tests approved" gate.** Only then implement.
- Every real AWS step is its own **[go]** gate, with the command and a cost estimate. Admin credentials are the owner's: I only use a profile name the owner gives me, and never read or print credentials.
- **No access key is ever created by code.** The template has no `AWS::IAM::AccessKey` and the script never calls `create-access-key`. The script masks access key IDs as `AKIA…<last 4>`.
- Teardown only touches the stack named `<prefix>` and images named `<prefix>-*`. It refuses `--prefix hq-smoke`. The default prefix is `throwbox`; the owner's account test (option B) uses `throwbox-test`.
- Dry run by default; `--yes` applies. The same words as kill-all: "Dry run: … Nothing was changed."
- Every push is public. Scan for `sk-or-`, `github_pat_`, `AKIA`, 12-digit account ids, the owner's email and `C:\Users`. Measurements committed to the repo use `<account-id>` in place of the real id.
- `npm run smoke` keeps its behaviour and its image name `hq-smoke-<timestamp>`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## What the code says (checked on 2026-11-26)

| Fact | Where | Consequence |
|---|---|---|
| The image build (zip, `s3 cp`, `create-microvm-image` with hooks, poll `get-microvm-image` by ARN until `CREATED`, fail on `/FAIL/`, 30-minute timeout) is inline in `main()`. | `scripts/smoke-test.ts:455-483` | Extract it to `buildImage()` with an injected CLI runner; `main()` calls it. |
| `aws(region, ...args)` uses `execFileSync("aws", …)` and parses JSON. | `scripts/smoke-test.ts:347-350` | Becomes the default `AwsCli` runner and is exported for reuse. |
| The zip uses `%SystemRoot%\System32\tar.exe` on Windows (GNU tar breaks). | `scripts/smoke-test.ts:353-361` | `makeZip` moves with `buildImage`. Do not "simplify" it. |
| The connector ARNs are `arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:<KIND>`. | `scripts/smoke-test.ts:60` | The template uses `Fn::Sub` with `${AWS::Region}`. |
| The base image is `arn:aws:lambda:<region>:aws:microvm-image:al2023-1`, and the architecture is `X86_64`. | `scripts/smoke-test.ts:77-80` | Unchanged. |
| `kill-all.ts` exposes pure `planKill`, `killAll(deps, opts)` and `formatReport`, with a guarded `main`. | `scripts/kill-all.ts` | The same shape for `setup-aws.ts`. |
| `npm test` lists test files explicitly, apart from the `tests/unit/*.test.ts` glob. | `package.json:9` | Put the new tests in `tests/unit/` so they need no script change. Add `setup:aws` to `scripts`. |

## Task 0: Verify AWS facts from the docs (no cost, no AWS calls)

- [ ] Confirm from the AWS Lambda MicroVMs documentation, recording the URL for each:
  - the build role's trust principal, and the permissions the build needs (S3 read; which `logs:` actions on which log group);
  - the exact IAM actions behind `lambda:*Microvm*` (that it covers `CreateMicrovmImage`, `GetMicrovmImage`, `ListMicrovmImages`, `DeleteMicrovmImage`, `RunMicrovm`, `TerminateMicrovm`, `ListMicrovms` and `CreateMicrovmAuthToken`);
  - the CLI names and arguments for `list-microvm-images` and `delete-microvm-image`.

  Also confirm from the CloudFormation docs that deleting a stack fails on an `AWS::IAM::User` that still has access keys made outside the stack.
- [ ] Write the findings into the plan's table above, as an update to this file. **Any difference from the spec goes back to the owner before Task 1.**

### Task 1: Extract `buildImage()` from smoke-test

**Files:** modify `scripts/smoke-test.ts`. Test: `scripts/smoke-test.test.ts` (new `describe`).

**Interfaces (produced):**

```ts
export type AwsCli = (region: string, ...args: string[]) => any;          // JSON-parsed stdout; throws on a non-zero exit
export type S3Upload = (region: string, file: string, s3Uri: string) => void;
export async function buildImage(o: {
  region: string; bucket: string; buildRoleArn: string; name: string;
  aws?: AwsCli; upload?: S3Upload; zip?: () => string; sleep?: (ms: number) => Promise<void>; log?: (s: string) => void; now?: () => number;
}): Promise<{ imageArn: string; buildMs: number }>;
```

- [ ] **Step 1: Tests** with a fake `aws`, `upload` and `zip`:
  - the upload goes to `s3://<bucket>/smoke/<name>.zip`;
  - the create call's args equal `createImageCliArgs(buildImageRequest(...))`, including `--hooks`;
  - it polls by **ARN**, not by name;
  - `CREATING`, `CREATING`, `CREATED` resolves with the ARN;
  - `FAILED` rejects with the CloudWatch log-group hint;
  - a missing `imageArn` rejects;
  - 30 minutes without `CREATED` rejects with a timeout.
- [ ] **Step 2: Stub** (`throw new Error("not implemented")`). **Red run** `node --test scripts/smoke-test.test.ts`: only the new tests fail, and only on assertions.
- [ ] **Step 3: "tests approved" gate.**
- [ ] **Step 4: Move the code.**
  - `main()` keeps `const name = \`hq-smoke-${Date.now()}\``, then calls `buildImage({ region, bucket, buildRoleArn, name })`.
  - `SMOKE_IMAGE_ARN` adoption (waiting for an in-flight image) still uses the same poll, by calling an exported `waitForImage(aws, region, imageArn, …)`. `buildImage` uses it too.
- [ ] **Step 5: Green**, then `npm test`. **Commit** `refactor: export buildImage() from smoke-test so setup can reuse it`.

### Task 2: CloudFormation template

**Files:** create `scripts/setup/throwbox-aws.json` and `tests/unit/setup-template.test.ts`.

Content (exact, apart from formatting):
- `Parameters.Prefix`: `String`, default `throwbox`, `AllowedPattern` `^[a-z][a-z0-9-]{1,30}$`.
- **`Bucket`**:
  - `BucketName` is `${Prefix}-images-${AWS::AccountId}-${AWS::Region}`;
  - `PublicAccessBlockConfiguration` has all four settings `true`;
  - `BucketEncryption` uses `AES256`.
- **`BuildRole`** is `${Prefix}-microvm-build`:
  - its trust is `lambda.amazonaws.com` with `sts:AssumeRole` (adjusted by Task 0);
  - inline policy `build`: `s3:GetObject` on `arn:aws:s3:::<bucket>/*`, and `logs:CreateLogGroup`, `logs:CreateLogStream` and `logs:PutLogEvents` on `arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda-microvms/*`.
- **`OperatorUser`** is `${Prefix}-operator`, with inline policy `throwbox-operator`. Each `Sid` is one row:

| Sid | Action | Resource | Condition |
|---|---|---|---|
| `Microvms` | `lambda:*Microvm*` | `*` | |
| `Connectors` | `lambda:PassNetworkConnector` | the two connector ARNs | |
| `ImageBucket` | `s3:PutObject`, `s3:GetObject` | `<bucket>/*` | |
| `PassBuildRole` | `iam:PassRole` | `BuildRole.Arn` | `StringEquals iam:PassedToService lambda.amazonaws.com` |
| `ReadLogs` | `logs:DescribeLogStreams`, `logs:GetLogEvents`, `logs:FilterLogEvents` | the `/aws/lambda-microvms/*` log groups | |

- `Outputs`: `BucketName`, `BuildRoleArn`, `OperatorUserName`.

- [ ] **Step 1: Tests** (`JSON.parse` the file):
  - the resource types are exactly `AWS::S3::Bucket`, `AWS::IAM::Role` and `AWS::IAM::User`, with no `AccessKey`, `LoginProfile`, `ManagedPolicy` or `Group`;
  - the operator's statements deep-equal the table;
  - no `Action` is `*` or `iam:*` or `s3:*`;
  - the only wildcard action is `lambda:*Microvm*`;
  - `PassRole` has the condition;
  - the bucket blocks public access and is encrypted;
  - the outputs contain no `Secret` or `AccessKey`;
  - `Prefix` has the pattern and the default.
- [ ] **Step 2:** Use an empty template stub `{"Resources":{}}` and do the red run.
- [ ] **Step 3: "tests approved" gate.**
- [ ] **Step 4: Write the template, then green.**
- [ ] **Step 5: Optional local lint.** If `cfn-lint` is installed, run it; otherwise skip it and say so. No AWS call.
- [ ] **Step 6: Commit** `feat: CloudFormation template for the Throwbox AWS setup (bucket, build role, scoped user)`.

### Task 3: `scripts/setup-aws.ts`: plan and apply

**Files:** create `scripts/setup-aws.ts` and `tests/unit/setup-aws.test.ts`. Modify `package.json` (`"setup:aws": "node scripts/setup-aws.ts"`).

**Interfaces (produced):**

```ts
export type SetupOpts = { yes: boolean; teardown: boolean; rebuildImage: boolean; prefix: string; region: string };
export function parseArgs(argv: string[]): SetupOpts;            // throws on unknown flags or an invalid prefix
export type SetupDeps = { aws: AwsCli; buildImage: typeof buildImage; log(s: string): void; sleep(ms: number): Promise<void>; now(): number };
export function describePolicies(template: any): string[];       // one line per statement: "<role|user> <Sid>: <actions> on <resources> [if <condition>]"
export function isEmptyChangeSet(d: { Status: string; StatusReason?: string }): boolean; // FAILED + /didn't contain changes|No updates are to be performed/
export function formatChanges(changes: any[]): string[];          // "Add AWS::IAM::User OperatorUser" and so on
export async function setup(d: SetupDeps, o: SetupOpts): Promise<0 | 1>;
```

`setup` flow:
1. `sts get-caller-identity`, and print the ARN.
2. `cloudformation describe-stacks --stack-name <prefix>`: not found means `CREATE`; a `*_COMPLETE` stack means `UPDATE`; `ROLLBACK_COMPLETE` or `*_FAILED` prints the events and the teardown hint, and returns 1.
3. `create-change-set` with `--capabilities CAPABILITY_NAMED_IAM`, `--template-body file://…` and `--parameters Prefix=…`, then wait with `describe-change-set` polling.
4. Print `formatChanges` and `describePolicies`. An empty change set prints "Nothing to change in the stack." and deletes the change set.
5. Image: `list-microvm-images`, filtered by name prefix `<prefix>-` and state `CREATED`. Print "will build an image" or "image exists: <name>".
6. Without `--yes`: print "Dry run: nothing was changed. Run again with --yes to apply." and return 0. **No `execute-change-set` call and no `buildImage` call.**
7. With `--yes`:
   - `execute-change-set`, then poll `describe-stacks` until `*_COMPLETE`; a rollback prints the events and returns 1;
   - read the outputs;
   - `buildImage({ name: \`${prefix}-${now()}\`, … })` when needed;
   - print the `.env` lines and the access key instructions (Console path, `aws configure --profile <prefix>-operator`).

The AWS CLI error text is passed through. An `AccessDenied` or `UnauthorizedOperation` adds the fixed "needs admin-level AWS access" line.

- [ ] **Step 1: Tests**, using a fake `aws` that routes calls by their first two args and records them:
  - `parseArgs` handles the flags, defaults and invalid prefixes;
  - a dry run against a new stack: the calls include `create-change-set` but **never** `execute-change-set` or `buildImage`, and the output contains every policy `Sid`;
  - with `--yes` against a new stack: it executes, waits, reads the outputs, calls `buildImage` once with the prefix name, and prints the env lines;
  - a re-run with no changes: `isEmptyChangeSet` is true, it prints "Nothing to change", deletes the change set, never executes, skips the image when one exists, and returns 0;
  - `--rebuild-image` builds even when an image exists;
  - a stack in `ROLLBACK_COMPLETE` returns 1 and makes no change-set call;
  - `AccessDenied` gives the admin hint and exit 1;
  - the output never matches `/AKIA[0-9A-Z]{16}/` or `/aws_secret_access_key/i`, even when the fake returns such text in an unrelated field. The script only prints the fields it chooses.
- [ ] **Step 2: Stub, then the red run.**
- [ ] **Step 3: "tests approved" gate.**
- [ ] **Step 4: Implement, green, `npm test`. Commit** `feat: npm run setup:aws (dry run by default, --yes applies, re-runnable)`.

### Task 4: Teardown

**Files:** modify `scripts/setup-aws.ts` and `tests/unit/setup-aws.test.ts`.

**Interfaces:** `export async function teardown(d: SetupDeps & { killAll: typeof killAll }, o: SetupOpts): Promise<0 | 1>`, and `export function maskKeyId(id: string): string` (`AKIA…WXYZ`).

Order with `--yes`:
1. For each `<prefix>-*` image, `killAll({ yes: true, imageArn })`, reusing `scripts/kill-all.ts`.
2. `delete-microvm-image` for each.
3. `iam list-access-keys --user-name <prefix>-operator`, then `delete-access-key` for each (masked in the output).
4. `aws s3 rm s3://<bucket> --recursive`.
5. `cloudformation delete-stack`, then poll until it is gone.

Without `--yes`, it lists all of the above and changes nothing.

- [ ] **Step 1: Tests:**
  - `--prefix hq-smoke` is refused before any AWS call;
  - the dry run makes no delete or terminate call;
  - with `--yes` the order is exactly as above;
  - only images whose name starts with `<prefix>-` are touched, including when an `hq-smoke-1795605632129` image is in the fake list;
  - a missing stack prints "nothing to tear down" and returns 0;
  - one failed image delete does not stop the rest, and gives exit 1;
  - the output contains only masked key ids.
- [ ] **Steps 2 to 4:** red run, the "tests approved" gate, implement, green, commit `feat: setup:aws --teardown (dry run by default)`.

### Task 5: Real checks (option B: this account, prefix `throwbox-test`)

Before [go 1], the owner creates a temporary admin principal in the IAM Console and its profile, and tells me only the profile name. Every step runs as `$env:AWS_PROFILE = "<admin-profile>"`, never `kumpas-harness`, with `<p>` = `throwbox-test`.

- [ ] **[go 1] Dry run.** `npm run setup:aws -- --prefix <p>`. Cost $0. It creates and deletes one change set only. Check that the printed policy equals the template.
- [ ] **[go 2] Apply.** `npm run setup:aws -- --prefix <p> --yes`. It creates the stack and one image build of about 3 minutes. Cost: S3 storage of one zip (fractions of a cent); the image build cost is **not measured**. If `create-microvm-image` is refused, stop and ask.
- [ ] **[go 3] Re-run.** The same command again, expecting "Nothing to change" and "image exists". Cost $0.
- [ ] **[go 4] Scoped-user proof.** The owner creates the access key for `<p>-operator` in the IAM Console and runs `aws configure --profile <p>-operator` themselves. Then `$env:AWS_PROFILE="<p>-operator"`, `MICROVM_IMAGE_ARN=<printed>`, `npm start`, and one default hospital-queue run from the UI. Expect `done`. Also run `node scripts/kill-all.ts` (a dry run) as that user, to prove `list` works. Cost: a few cents (model about $0.002, MicroVM time not measured). **Any AccessDenied here is a template bug: a failing template test first, then the fix, then [go 2] and [go 4] again.**
- [ ] **[go 5] Teardown.** `npm run setup:aws -- --prefix <p> --teardown`, then the same with `--yes`. Check that `describe-stacks` says it does not exist, `list-microvm-images` shows no `<p>-*` image, and `aws iam get-user --user-name <p>-operator` gives NoSuchEntity. Cost $0. The owner then deletes the temporary admin principal and its profile.
- [ ] Record the timings and outcomes in `docs/measurements/setup-aws.json`, with `<account-id>` in place of the real id.

### Task 6: Docs

- [ ] **README:**
  - "Run it yourself", step 2: replace the IAM paragraph with `npm run setup:aws` (a dry run, then `--yes`), the admin requirement, and the access key step.
  - Keep a one-line pointer to the template for people who do it by hand.
  - In "What to know", replace "Not re-verified on a clean account" with: tested with `npm run setup:aws` on the author's existing account (option B), not on a clean one.
- [ ] **CONTRIBUTING:** it has no setup-script line today (checked 2026-11-26). Add one sentence: "`npm run setup:aws` needs admin AWS access; test changes to it with a dry run first."
- [ ] **DECISION_LOG:** "Setup: CloudFormation plus a thin script" (why not plain CLI calls: idempotence and deletion for free; why JSON: tests read the policy). Plus the evidence and the gaps.
- [ ] **VALIDATION:** a new section.
- [ ] Scan, then commit `docs: one-command AWS setup`. Push only with the owner's go, then `gh run watch`.
- [ ] **Remind the owner to edit the LinkedIn post line that invites others to build the setup script.**

## Not verified by this plan

- Regions other than `us-east-1`, and `ARM_64`.
- A truly clean account (option A): option B inherits this account's settings, such as MicroVMs already being enabled and the 8 GB quota.
- The image build's AWS cost.
- `cfn-lint` (only if it is installed locally).
- The template's policy is not compared with the live `kumpas-harness` policy, which that user cannot read. [go 4] is the functional proof instead.
- Behaviour when two setups run at the same time against one stack.
