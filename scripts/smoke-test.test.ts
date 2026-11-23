// Phase 0 smoke-test unit tests. Run: node --test scripts/smoke-test.test.ts
// No network, no AWS, no sleeps. The runner script is executed for real under Git Bash
// against a local git origin, with stub `codex`/`composer`/`php` binaries on PATH.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import * as S from "./smoke-test.ts";

const MODEL = "deepseek/deepseek-v4.1-flash"; // hand-authored, not imported
const EDITED = "app/Services/QueueEventLog.php";
const KEY = "sk-or-v1-TESTKEY-0123456789";
const IMAGE_ARN = "arn:aws:lambda:us-east-1:111122223333:microvm-image:hq-smoke";
const BASH = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";

// ---------- fixtures ----------
const fwd = (p: string) => p.replace(/\\/g, "/");
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
const stub = (p: string, body: string) => writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });

function makeRoot(): string {
  return fwd(mkdtempSync(join(tmpdir(), "smoke-")));
}

function makeOrigin(root: string): string {
  const dir = `${root}/origin`;
  mkdirSync(`${dir}/app/Services`, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(`${dir}/${EDITED}`, "<?php\nclass QueueEventLog {}\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

interface Scenario {
  task?: string;
  codexBody?: string; // runs in the cloned repo; default edits EDITED and adds a new untracked file
  codexExit?: number;
  composerExit?: number;
  phpExit?: number;
  testCmd?: string;
  appKey?: string;
}

function runScenario(root: string, o: Scenario = {}) {
  const bin = `${root}/bin`;
  mkdirSync(bin, { recursive: true });
  const edit = o.codexBody ?? `echo '// edited' >> ${EDITED}\necho '<?php // new' > app/Services/New.php`;
  stub(
    `${bin}/codex`,
    [
      `printf '%s\\0' "$@" > "$ROOT/codex.argv"`,
      `printf '%s' "$OPENROUTER_API_KEY" > "$ROOT/codex.key"`,
      `pwd > "$ROOT/codex.cwd"`,
      `echo '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}'`,
      edit,
      `echo '{"type":"turn.completed"}'`,
      `exit ${o.codexExit ?? 0}`,
    ].join("\n"),
  );
  stub(`${bin}/composer`, `echo "composer $*" >> "$ROOT/calls.log"\nexit ${o.composerExit ?? 0}`);
  stub(`${bin}/php`, `echo "php $*" >> "$ROOT/calls.log"\necho "$APP_KEY" >> "$ROOT/appkey.log"\nexit ${o.phpExit ?? 0}`);
  const scriptPath = `${root}/run-task.sh`;
  writeFileSync(scriptPath, S.buildRunnerScript());
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    ROOT: root,
    REPO_URL: makeOrigin(root),
    TASK: o.task ?? "add a comment to QueueEventLog",
    WORKDIR: `${root}/work`,
    OPENROUTER_API_KEY: KEY,
    MODEL,
  };
  if (o.testCmd) env.TEST_CMD = o.testCmd;
  delete env.APP_KEY;
  if (o.appKey) env.APP_KEY = o.appKey;
  // `-e` on purpose: the script must neutralise errexit itself (set +e) to capture TEST_EXIT.
  const r = spawnSync(BASH, ["-e", scriptPath], { env, encoding: "utf8", cwd: root });
  const lines = r.stdout.split(/\r?\n/);
  const events = lines.flatMap((l) => {
    try {
      const v = JSON.parse(l);
      return v && typeof v === "object" ? [v] : [];
    } catch {
      return [];
    }
  });
  const read = (f: string) => (existsSync(`${root}/${f}`) ? readFileSync(`${root}/${f}`, "utf8") : "");
  return { r, lines, events, read };
}

const idx = (lines: string[], needle: string) => lines.findIndex((l) => l.includes(needle));
const diffBlock = (lines: string[]) => lines.slice(idx(lines, "__DIFF_START__") + 1, idx(lines, "__DIFF_END__")).join("\n");

// ---------- (a) image build ----------
describe("image build request", () => {
  const df = S.buildDockerfile();
  const argVal = (n: string) => df.match(new RegExp(`^ARG ${n}=(\\S+)`, "m"))?.[1] ?? "";

  test("Dockerfile pins Node major >= 22 and installs it from that ARG", () => {
    assert.ok(Number(argVal("NODE_MAJOR")) >= 22, `NODE_MAJOR was "${argVal("NODE_MAJOR")}"`);
    assert.match(df, /\$\{?NODE_MAJOR\}?/);
  });

  test("Dockerfile pins PHP >= 8.2 and installs it from that ARG", () => {
    const [maj, min] = argVal("PHP_VERSION").split(".").map(Number);
    assert.ok(maj > 8 || (maj === 8 && min >= 2), `PHP_VERSION was "${argVal("PHP_VERSION")}"`);
    assert.match(df, /\$\{?PHP_VERSION\}?/);
  });

  for (const [what, re] of [
    ["composer", /composer/i],
    ["sqlite", /sqlite/i],
    ["git", /\bgit\b/],
    ["Codex CLI (@openai/codex)", /@openai\/codex/],
  ] as const) {
    test(`Dockerfile installs ${what}`, () => assert.match(df, re));
  }

  test("package ships the Dockerfile and the exact runner script the Dockerfile will run", () => {
    const pkg = S.buildImagePackage();
    assert.equal(pkg["Dockerfile"], df);
    assert.equal(pkg["run-task.sh"], S.buildRunnerScript());
    assert.ok(S.buildRunnerScript().length > 100);
  });

  test("no file in the image package contains the API key or an sk-or- token (no secret at snapshot time)", () => {
    const files = Object.entries(S.buildImagePackage());
    assert.ok(files.length >= 2 && files.every(([, body]) => body.length > 0), "package must be non-empty");
    for (const [name, body] of files) {
      assert.doesNotMatch(body, /sk-or-/, `${name} leaks a token`);
      assert.doesNotMatch(body, /OPENROUTER_API_KEY\s*=\s*\S/, `${name} bakes OPENROUTER_API_KEY`);
    }
    assert.doesNotMatch(df, /\bENV\s+OPENROUTER/);
  });

  test("create request points at the S3 zip, al2023-1 base image and build role, with no environmentVariables", () => {
    const req = S.buildImageRequest({
      name: "hq-smoke",
      bucket: "my-bucket",
      key: "smoke/app.zip",
      buildRoleArn: "arn:aws:iam::111122223333:role/MicrovmBuildRole",
    });
    assert.equal(req.name, "hq-smoke");
    assert.equal(req.codeArtifact.uri, "s3://my-bucket/smoke/app.zip");
    assert.equal(req.baseImageArn, "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1");
    assert.equal(req.buildRoleArn, "arn:aws:iam::111122223333:role/MicrovmBuildRole");
    assert.ok(req.cpuConfigurations.length === 1);
    assert.doesNotMatch(JSON.stringify(req), /environmentVariables/);
  });
});

// ---------- (b) run call ----------
describe("run request", () => {
  const repoUrl = "https://github.com/jyvnn/hospital-queue";
  const task = "Add a one-line comment above QueueEventLog::enabled()";
  const req = () => S.buildRunRequest({ imageArn: IMAGE_ARN, repoUrl, task, apiKey: KEY });

  test("runHookPayload carries exactly REPO_URL, TASK, OPENROUTER_API_KEY and the default model id", () => {
    assert.deepEqual(JSON.parse(req().runHookPayload), {
      REPO_URL: repoUrl,
      TASK: task,
      OPENROUTER_API_KEY: KEY,
      MODEL,
    });
  });

  test("the API key appears only inside runHookPayload, never in any other field", () => {
    const { runHookPayload, ...rest } = req();
    assert.ok(runHookPayload.includes(KEY));
    assert.doesNotMatch(JSON.stringify(rest), new RegExp(KEY));
  });

  test("run request has no environmentVariables, targets the image, and wires ingress + internet egress", () => {
    const r = req();
    assert.equal(r.imageIdentifier, IMAGE_ARN);
    assert.doesNotMatch(JSON.stringify(r), /environmentVariables/);
    assert.deepEqual(r.ingressNetworkConnectors, ["arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:HTTP_INGRESS"]);
    assert.deepEqual(r.egressNetworkConnectors, ["arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS"]);
    assert.ok(r.maximumDurationInSeconds >= 1 && r.maximumDurationInSeconds <= 28800);
  });

  test("a payload over the 16 KB runHookPayload limit is rejected before any AWS call", () => {
    assert.throws(() => S.buildRunRequest({ imageArn: IMAGE_ARN, repoUrl, task: "x".repeat(20000), apiKey: KEY }), /16/);
  });

  test("a payload just under the limit is accepted and its byte length stays <= 16384", () => {
    const filler = 16384 - Buffer.byteLength(JSON.stringify({ REPO_URL: repoUrl, TASK: "", OPENROUTER_API_KEY: KEY, MODEL })) - 64;
    const r = S.buildRunRequest({ imageArn: IMAGE_ARN, repoUrl, task: "x".repeat(filler), apiKey: KEY });
    assert.ok(Buffer.byteLength(r.runHookPayload) <= 16384);
    assert.equal(JSON.parse(r.runHookPayload).TASK?.length, filler, "the full task must survive, not be truncated");
  });

  test("repo URL validation accepts only https://github.com/<owner>/<repo>", () => {
    for (const ok of ["https://github.com/jyvnn/hospital-queue", "https://github.com/a/b.git"]) {
      assert.equal(S.validateRepoUrl(ok), true, ok);
    }
    for (const bad of [
      "http://github.com/a/b",
      "https://evil.com/a/b",
      "https://github.com.evil.com/a/b",
      "https://github.com@evil.com/a/b",
      "git@github.com:a/b.git",
      "file:///etc/passwd",
      "https://github.com/a/b --upload-pack=x",
      "",
    ]) {
      assert.equal(S.validateRepoUrl(bad), false, bad);
    }
  });

  test("buildRunRequest throws on an invalid repo URL", () => {
    assert.throws(() => S.buildRunRequest({ imageArn: IMAGE_ARN, repoUrl: "https://evil.com/a/b", task, apiKey: KEY }), /repo/i);
  });
});

// ---------- (c) POST to the idle runner ----------
describe("runner POST after restore", () => {
  test("POSTs { repoUrl, task } as JSON to https://<endpoint>/ on port 8080 with the proxy auth token", () => {
    const p = S.buildRunnerPost({ endpoint: "abc123.lambda-microvms.us-east-1.on.aws", authToken: "tok-1", repoUrl: "https://github.com/a/b", task: 'say "hi"' });
    assert.equal(p.method, "POST");
    assert.equal(p.url, "https://abc123.lambda-microvms.us-east-1.on.aws/");
    assert.equal(p.headers["X-aws-proxy-auth"], "tok-1");
    assert.equal(p.headers["X-aws-proxy-port"], "8080");
    assert.equal(p.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(p.body), { repoUrl: "https://github.com/a/b", task: 'say "hi"' });
  });
});

describe("runner script: codex invocation", () => {
  test("hostile TASK reaches codex as ONE argv element, after `--`, with no shell injection", () => {
    const root = makeRoot();
    const hostile = `a b; touch ${root}/PWN1 && echo $(touch ${root}/PWN2) \`touch ${root}/PWN3\` 'q' "d"`;
    const { read } = runScenario(root, { task: hostile });
    const argv = read("codex.argv").split("\0").slice(0, -1);
    assert.equal(argv.at(-1), hostile);
    assert.equal(argv.at(-2), "--");
    assert.equal(argv.filter((a) => a.includes("touch")).length, 1);
    for (const f of ["PWN1", "PWN2", "PWN3"]) assert.equal(existsSync(`${root}/${f}`), false, `${f} was created`);
  });

  test("a TASK starting with a dash is not parsed as a codex flag", () => {
    const root = makeRoot();
    const { read } = runScenario(root, { task: "--dangerously-bypass-approvals-and-sandbox" });
    const argv = read("codex.argv").split("\0").slice(0, -1);
    assert.deepEqual(argv.slice(-2), ["--", "--dangerously-bypass-approvals-and-sandbox"]);
  });

  test("codex is run as `exec` with --json, workspace-write sandbox, never-approval and the qwen3-coder model", () => {
    const root = makeRoot();
    const { read } = runScenario(root);
    const argv = read("codex.argv").split("\0").slice(0, -1);
    const joined = argv.join(" ");
    assert.equal(argv[0], "exec");
    assert.ok(argv.includes("--json"));
    assert.ok(argv.includes("--skip-git-repo-check"));
    assert.match(joined, /sandbox_mode=workspace-write/);
    assert.match(joined, /approval_policy=never/);
    assert.ok(joined.includes(MODEL));
  });

  test("the API key reaches codex through its environment and never through argv", () => {
    const root = makeRoot();
    const { read } = runScenario(root);
    assert.equal(read("codex.key"), KEY);
    assert.ok(!read("codex.argv").includes(KEY));
  });

  test("codex runs inside the cloned repo (WORKDIR), not the caller's cwd", () => {
    const root = makeRoot();
    const { read } = runScenario(root);
    // Git Bash maps the Windows temp dir to /tmp, so compare the unique trailing segments only.
    const tail = (p: string) => p.trim().split("/").slice(-2).join("/");
    assert.equal(tail(read("codex.cwd")), tail(`${root}/work`));  });
});

// ---------- (d) JSONL ----------
describe("codex JSONL", () => {
  test("script passes codex's JSONL lines through to stdout, parseable and in order", () => {
    const { events } = runScenario(makeRoot());
    const types = events.map((e) => e.type);
    assert.ok(types.indexOf("item.completed") < types.indexOf("turn.completed"));
    assert.equal(events.find((e) => e.type === "item.completed")?.item?.text, "thinking");
  });

  test("parseCodexJsonl parses one event per line, tolerating CRLF, blank lines and a truncated last line", () => {
    const out = '{"type":"a"}\r\n\r\n{"type":"b","n":2}\n{"type":"c","tr';
    const r = S.parseCodexJsonl(out);
    assert.deepEqual(r.events, [{ type: "a" }, { type: "b", n: 2 }]);
    assert.equal(r.malformed, 1);
  });

  test("plain-text (non-JSONL) output yields zero events and counts every non-empty line as malformed", () => {
    const r = S.parseCodexJsonl("Thinking...\nEditing file\n");
    assert.deepEqual(r.events, []);
    assert.equal(r.malformed, 2);
  });

  test("JSON that is not an object (a bare number or string) is malformed, not an event", () => {
    const r = S.parseCodexJsonl('42\n"x"\n{"type":"ok"}\n');
    assert.deepEqual(r.events, [{ type: "ok" }]);
    assert.equal(r.malformed, 2);
  });

  test("firstReasoningIndex finds the first reasoning item, or -1 when there is none", () => {
    const evs = [{ type: "thread.started" }, { type: "item.completed", item: { type: "agent_message" } }, { type: "item.completed", item: { type: "reasoning" } }];
    assert.equal(S.firstReasoningIndex(evs), 2);
    assert.equal(S.firstReasoningIndex(evs.slice(0, 2)), -1);
    assert.equal(S.firstReasoningIndex([]), -1);
  });
});

// ---------- (e) test command with set +e ----------
describe("runner script: test step", () => {
  test("default test command runs `composer install --no-interaction` then `php artisan test`", () => {
    const root = makeRoot();
    const { read } = runScenario(root);
    assert.deepEqual(read("calls.log").trim().split(/\r?\n/), ["composer install --no-interaction", "php artisan test"]);
  });

  test("when composer install fails, php artisan test is NOT run and test_result carries composer's exit code", () => {
    const root = makeRoot();
    const { read, events } = runScenario(root, { composerExit: 7 });
    assert.deepEqual(read("calls.log").trim().split(/\r?\n/), ["composer install --no-interaction"]);
    assert.equal(events.find((e) => e.type === "test_result")?.exitCode, 7);
  });

  test("a failing test run (exit 3) under bash -e still emits test_result exitCode 3 and still captures the diff", () => {
    const root = makeRoot();
    const { lines, events } = runScenario(root, { phpExit: 3 });
    const tr = events.find((e) => e.type === "test_result");
    assert.equal(tr?.exitCode, 3);
    assert.equal(typeof tr?.ts, "number");
    assert.ok(idx(lines, '"test_result"') < idx(lines, "__DIFF_START__"));
    assert.ok(diffBlock(lines).includes(`diff --git a/${EDITED}`));
  });

  test("a passing test run emits test_result exitCode 0", () => {
    const { events } = runScenario(makeRoot());
    assert.equal(events.find((e) => e.type === "test_result")?.exitCode, 0);
  });

  test("a failing codex (exit 2) is reported as codex_exit 2 and does not stop the test or diff steps", () => {
    const root = makeRoot();
    const { events, lines, read } = runScenario(root, { codexExit: 2 });
    assert.equal(events.find((e) => e.type === "codex_exit")?.exitCode, 2);
    assert.equal(events.find((e) => e.type === "test_result")?.exitCode, 0);
    assert.ok(read("calls.log").includes("php artisan test"));
    assert.ok(idx(lines, "__DIFF_END__") > idx(lines, "__DIFF_START__"));
  });

  test("events appear in order: codex output, codex_exit, test_result, then the diff block", () => {
    const { lines } = runScenario(makeRoot());
    const order = [idx(lines, '"turn.completed"'), idx(lines, '"codex_exit"'), idx(lines, '"test_result"'), idx(lines, "__DIFF_START__"), idx(lines, "__DIFF_END__")];
    assert.ok(order.every((n) => n >= 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });
});

// ---------- (f) diff capture ----------
describe("runner script: diff capture", () => {
  test("the edited tracked file AND an untracked new file both appear in the emitted patch", () => {
    const { lines } = runScenario(makeRoot());
    const d = diffBlock(lines);
    assert.ok(d.includes(`diff --git a/${EDITED} b/${EDITED}`));
    assert.ok(d.includes("+// edited"));
    assert.ok(d.includes("diff --git a/app/Services/New.php b/app/Services/New.php"));
  });

  test("when codex changes nothing the diff block is empty", () => {
    const { lines } = runScenario(makeRoot(), { codexBody: ":" });
    assert.ok(idx(lines, "__DIFF_START__") >= 0 && idx(lines, "__DIFF_END__") > idx(lines, "__DIFF_START__"), "diff markers must still be emitted");
    assert.equal(diffBlock(lines).trim(), "");
  });

  test("extractDiff returns exactly the text between the markers", () => {
    const out = 'noise\n{"type":"x"}\n__DIFF_START__\ndiff --git a/f b/f\n+x\n__DIFF_END__\ntrailing\n';
    assert.equal(S.extractDiff(out), "diff --git a/f b/f\n+x\n");
  });

  test("extractDiff returns an empty string when markers are missing or unterminated", () => {
    assert.equal(S.extractDiff("no markers"), "");
    assert.equal(S.extractDiff("__DIFF_START__\ndiff --git a/f b/f\n"), "");
  });
});

// ---------- (g) gate ----------
describe("gate", () => {
  const good = `diff --git a/${EDITED} b/${EDITED}\n--- a/${EDITED}\n+++ b/${EDITED}\n+// x\n`;

  test("passes with exit code 0 when the diff is non-empty and includes the edited file", () => {
    const g = S.evaluateGate({ diff: good, editedFile: EDITED });
    assert.deepEqual([g.passed, g.exitCode, g.reasons], [true, 0, []]);
  });

  test("an empty diff fails with exit code 1", () => {
    const g = S.evaluateGate({ diff: "", editedFile: EDITED });
    assert.equal(g.passed, false);
    assert.equal(g.exitCode, 1);
    assert.match(g.reasons.join(" "), /empty/i);
  });

  test("a whitespace-only diff fails like an empty one", () => {
    assert.equal(S.evaluateGate({ diff: " \n\t\n", editedFile: EDITED }).exitCode, 1);
  });

  test("a non-empty diff that does not include the edited file fails and names the file", () => {
    const g = S.evaluateGate({ diff: "diff --git a/other.php b/other.php\n+x\n", editedFile: EDITED });
    assert.equal(g.passed, false);
    assert.equal(g.exitCode, 1);
    assert.ok(g.reasons.join(" ").includes(EDITED));
  });

  test("diffTouchesFile matches exact paths only, not substrings, similar names, or file content", () => {
    assert.equal(S.diffTouchesFile(good, EDITED), true);
    assert.equal(S.diffTouchesFile(`diff --git a/${EDITED}.bak b/${EDITED}.bak\n`, EDITED), false);
    assert.equal(S.diffTouchesFile(`diff --git a/x/${EDITED} b/x/${EDITED}\n`, EDITED), false);
    assert.equal(S.diffTouchesFile(`diff --git a/other.php b/other.php\n+// ${EDITED}\n`, EDITED), false);
    assert.equal(S.diffTouchesFile("", EDITED), false);
  });
});

// ---------- timings + report ----------
describe("timings and report", () => {
  test("computeTimings returns submit->ready and submit->first-reasoning in ms", () => {
    assert.deepEqual(S.computeTimings({ submitMs: 1000, readyMs: 1850, firstReasoningMs: 6200 }), { submitToReadyMs: 850, submitToFirstReasoningMs: 5200 });
  });

  test("computeTimings reports null first-reasoning when no reasoning event arrived", () => {
    assert.equal(S.computeTimings({ submitMs: 1000, readyMs: 1850, firstReasoningMs: null }).submitToFirstReasoningMs, null);
  });

  test("computeTimings rejects a ready time before the submit time", () => {
    assert.throws(() => S.computeTimings({ submitMs: 2000, readyMs: 1000, firstReasoningMs: null }), /before/i);
  });

  test("formatReport prints all eight Phase 0 numbers on labelled lines", () => {
    const out = S.formatReport({
      imageBuildMs: 42500, runMs: 3200, submitToReadyMs: 1234, submitToFirstReasoningMs: 5600,
      codexExit: 0, testExit: 1, diffBytes: 321, editedFilePresent: true,
    });
    assert.deepEqual(out.trim().split(/\r?\n/), [
      "image_build_seconds: 42.5",
      "run_seconds: 3.2",
      "submit_to_sandbox_ready_seconds: 1.234",
      "submit_to_first_reasoning_token_seconds: 5.6",
      "codex_exit_code: 0",
      "test_exit_code: 1",
      "diff_bytes: 321",
      "edited_file_in_diff: true",
    ]);
  });

  test("formatReport prints n/a when there was no reasoning token", () => {
    const out = S.formatReport({
      imageBuildMs: 1000, runMs: 1000, submitToReadyMs: 1000, submitToFirstReasoningMs: null,
      codexExit: 0, testExit: 0, diffBytes: 0, editedFilePresent: false,
    });
    assert.match(out, /^submit_to_first_reasoning_token_seconds: n\/a$/m);
    assert.match(out, /^edited_file_in_diff: false$/m);
  });
});

// ---------- TDD fix 1: create-image passes --hooks ----------
describe("create-image hooks", () => {
  const HOOKS = { port: 8080, microvmHooks: { run: "ENABLED" }, microvmImageHooks: { ready: "ENABLED" } };
  const req = () =>
    S.buildImageRequest({ name: "hq", bucket: "b", key: "k.zip", buildRoleArn: "arn:aws:iam::1:role/r" });
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

  test("the image request enables the run and ready hooks on port 8080", () => {
    assert.deepEqual(req().hooks, HOOKS);
  });

  test("the create-microvm-image CLI call passes --hooks with port 8080, run=ENABLED, ready=ENABLED", () => {
    const args = S.createImageCliArgs(req());
    assert.ok(args.includes("--hooks"), "missing --hooks flag");
    assert.deepEqual(JSON.parse(flag(args, "--hooks")), HOOKS);
  });

  test("the CLI call still carries name, S3 artifact, base image, build role and x86_64", () => {
    const args = S.createImageCliArgs(req());
    assert.deepEqual(args.slice(0, 2), ["lambda-microvms", "create-microvm-image"]);
    assert.equal(flag(args, "--name"), "hq");
    assert.equal(flag(args, "--code-artifact"), "uri=s3://b/k.zip");
    assert.equal(flag(args, "--base-image-arn"), "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1");
    assert.equal(flag(args, "--build-role-arn"), "arn:aws:iam::1:role/r");
    assert.equal(flag(args, "--cpu-configurations"), "architecture=X86_64");
  });
});

// ---------- TDD fix 2: model-call failures are visible, exit 2 before the gate ----------
describe("codex failure surfacing", () => {
  const started = { type: "thread.started", thread_id: "t1" };
  const warning = { type: "item.completed", item: { id: "item_0", type: "error", message: "Model metadata for `x` not found. Defaulting to fallback metadata" } };
  const err = { type: "error", message: "404 model not found: qwen/qwen3-coder-30b-a3b-instruct" };
  const failed = { type: "turn.failed", error: { message: "model call rejected" } };
  const done = { type: "turn.completed" };
  const goodDiff = `diff --git a/${EDITED} b/${EDITED}\n+// x\n`;

  test("findCodexFailures returns exactly the error and turn.failed events, untouched and in order", () => {
    assert.deepEqual(S.findCodexFailures([started, warning, err, done, failed]), [err, failed]);
  });

  test("an item-level 'Model metadata not found' warning is not a failure", () => {
    assert.deepEqual(S.findCodexFailures([started, warning, done]), []);
  });

  test("formatCodexFailures prints a count line then each failing event verbatim as one JSON line", () => {
    assert.equal(
      S.formatCodexFailures([err, failed]),
      'codex_failures: 2\n{"type":"error","message":"404 model not found: qwen/qwen3-coder-30b-a3b-instruct"}\n{"type":"turn.failed","error":{"message":"model call rejected"}}\n',
    );
  });

  test("formatCodexFailures prints nothing when there are no failures", () => {
    assert.equal(S.formatCodexFailures([]), "");
  });

  test("a codex error exits 2 even when the diff looks fine (failure is not swallowed by the gate)", () => {
    const d = S.decideExit({ events: [started, err, done], diff: goodDiff, editedFile: EDITED });
    assert.equal(d.exitCode, 2);
    assert.deepEqual(d.failures, [err]);
  });

  test("turn.failed with an empty diff exits 2, not the gate's 1", () => {
    assert.equal(S.decideExit({ events: [failed], diff: "", editedFile: EDITED }).exitCode, 2);
  });

  test("without codex failures the gate decides: empty diff -> 1, good diff -> 0", () => {
    assert.equal(S.decideExit({ events: [started, warning, done], diff: "", editedFile: EDITED }).exitCode, 1);
    const ok = S.decideExit({ events: [started, done], diff: goodDiff, editedFile: EDITED });
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.gate.passed, true);
  });
});

// ---------- APP_KEY: the repo's own ExampleTest needs one in a fresh clone ----------
describe("runner script: Laravel APP_KEY", () => {
  const keys = (read: (f: string) => string) => read("appkey.log").trim().split(/\r?\n/);

  test("the test command runs with a fresh APP_KEY: base64: + 32 random bytes", () => {
    const { read } = runScenario(makeRoot());
    assert.match(keys(read)[0], /^base64:[A-Za-z0-9+/]{43}=$/);
  });

  test("a caller-provided APP_KEY is respected, not overwritten", () => {
    const { read } = runScenario(makeRoot(), { appKey: "base64:CALLERKEYCALLERKEYCALLERKEYCALLERKEY0=" });
    assert.equal(keys(read)[0], "base64:CALLERKEYCALLERKEYCALLERKEYCALLERKEY0=");
  });

  test("two runs never share an APP_KEY", () => {
    const a = keys(runScenario(makeRoot()).read)[0];
    const b = keys(runScenario(makeRoot()).read)[0];
    assert.notEqual(a, b);
  });

  test("the test command itself is unchanged: still composer install then php artisan test", () => {
    const { read } = runScenario(makeRoot());
    assert.deepEqual(read("calls.log").trim().split(/\r?\n/), ["composer install --no-interaction", "php artisan test"]);
  });
});
