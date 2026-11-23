// PatchDelivery.pushBranch: apply the captured diff to a fresh clone at the run's base commit, push harness/<runId>.
// Part A runs REAL git against local bare repos (offline, deterministic). Part B injects a fake git to assert the exact
// command sequence and that the token never reaches argv, logs or errors. Run: node --test tests/unit/patch-delivery.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatchDelivery, type GitExec, type PushInput, type PushResult } from "../../api/patch-delivery.ts";
import { createRedactor } from "../../api/redact.ts";

const TOKEN = "github_pat_11TESTTOKEN_abcdefghijklmnopqrstuvwxyz0123456789";
const B64 = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
const FILE = "app/Services/QueueEventLog.php";
const SRC = "https://github.com/jyvnn/hospital-queue";
const DST = "https://github.com/johnsiega/hospital-queue-harness";
const SHA = "ea724cea11c755453e8d826872470b2448c1cca1";
const PATCH = `diff --git a/${FILE} b/${FILE}\n--- a/${FILE}\n+++ b/${FILE}\n@@ -1,2 +1,3 @@\n <?php\n+// harness\n class X {}\n`;
const fwd = (p: string) => p.replace(/\\/g, "/");

// ---------- real-git fixtures ----------
const G = ["-c", "core.autocrlf=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com"];
const git = (cwd: string, ...a: string[]) => execFileSync("git", [...G, ...a], { cwd, encoding: "utf8" });
const gitBuf = (cwd: string, ...a: string[]) => execFileSync("git", [...G, ...a], { cwd });
const bare = (dir: string, ...a: string[]) => {
  try { return execFileSync("git", ["--git-dir", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "<git failed>"; }
};
const showBlob = (dir: string, ref: string) => {
  try { return execFileSync("git", ["--git-dir", dir, "show", ref], { stdio: ["ignore", "pipe", "ignore"] }); } catch { return Buffer.alloc(0); }
};

function repos() {
  const root = fwd(mkdtempSync(join(tmpdir(), "pd-")));
  const source = `${root}/source`;
  const target = `${root}/target.git`;
  const tmpRoot = `${root}/work`;
  mkdirSync(`${source}/app/Services`, { recursive: true });
  mkdirSync(tmpRoot);
  git(source, "init", "-q", "-b", "main");
  const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  writeFileSync(`${source}/${FILE}`, `<?php\n${body}`);
  writeFileSync(`${source}/crlf.txt`, "a\r\nb\r\n");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "c1");
  const base = git(source, "rev-parse", "HEAD").trim();
  writeFileSync(`${source}/README.md`, "later\n");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "c2 (main moved on)");
  const tip = git(source, "rev-parse", "HEAD").trim();
  execFileSync("git", ["init", "-q", "--bare", target]);
  git(source, "push", "-q", target, "main");
  return { root, source, target, tmpRoot, base, tip };
}

// Builds a genuine `git diff --cached --binary` against the base, the same way the runner does.
function patchFor(r: ReturnType<typeof repos>, edit: (dir: string) => void): string {
  const dir = `${r.root}/scratch-${Math.random().toString(36).slice(2)}`;
  git(r.root, "clone", "-q", r.source, dir);
  git(dir, "checkout", "-q", r.base);
  edit(dir);
  git(dir, "add", "-A");
  return git(dir, "diff", "--cached", "--binary");
}
const addComment = (dir: string) => writeFileSync(`${dir}/${FILE}`, `<?php\n// harness comment\n${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);

const real = (r: ReturnType<typeof repos>) => createPatchDelivery({ allowLocal: true, tmpRoot: r.tmpRoot });
const input = (r: ReturnType<typeof repos>, diff: string, o: Partial<PushInput> = {}): PushInput =>
  ({ sourceUrl: r.source, targetUrl: r.target, baseCommit: r.base, diff, runId: "run-1", token: TOKEN, ...o });
const failed = (res: PushResult) => { assert.equal(res.ok, false, "expected a failure"); return res as Extract<PushResult, { ok: false }>; };
const branchSha = (r: ReturnType<typeof repos>, id = "run-1") => execFileSync("git", ["ls-remote", r.target, `refs/heads/harness/${id}`], { encoding: "utf8" }).trim();

// ====================================================================================================
describe("pushBranch with real git", () => {
  test("pushes exactly one commit on harness/<runId> whose parent is the base and whose tree is base plus the patch", async () => {
    const r = repos();
    const res = await real(r).pushBranch(input(r, patchFor(r, addComment)));
    assert.equal(res.ok, true, JSON.stringify(res));
    const ok = res as Extract<PushResult, { ok: true }>;
    assert.equal(ok.branch, "harness/run-1");
    assert.match(ok.commit, /^[0-9a-f]{40}$/);
    assert.equal(bare(r.target, "rev-parse", "harness/run-1"), ok.commit);
    assert.equal(bare(r.target, "rev-parse", "harness/run-1^"), r.base);
    assert.equal(bare(r.target, "rev-list", "--count", `${r.base}..harness/run-1`), "1");
    assert.equal(bare(r.target, "diff", "--name-only", r.base, "harness/run-1"), FILE);
    assert.match(bare(r.target, "show", `harness/run-1:${FILE}`), /^<\?php\n\/\/ harness comment\nline 1\n/);
  });

  test("applies on the base commit even after main moved on, and never touches main", async () => {
    const r = repos();
    assert.notEqual(r.base, r.tip);
    const res = await real(r).pushBranch(input(r, patchFor(r, addComment)));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(bare(r.target, "rev-parse", "harness/run-1^"), r.base, "parent must be the base, not main's tip");
    assert.equal(bare(r.target, "rev-parse", "main"), r.tip, "main must be untouched");
  });

  test("a binary file in the patch arrives byte for byte", async () => {
    const r = repos();
    const patch = patchFor(r, (d) => { addComment(d); writeFileSync(`${d}/app/blob.bin`, Buffer.from([0, 1, 2, 255, 254])); });
    assert.ok(patch.includes("GIT binary patch"));
    const res = await real(r).pushBranch(input(r, patch));
    assert.equal(res.ok, true, JSON.stringify(res));
    const blob = showBlob(r.target, "harness/run-1:app/blob.bin");
    assert.deepEqual([...blob], [0, 1, 2, 255, 254]);
  });

  test("CRLF line endings survive: no conversion on a machine whose global git config sets autocrlf", async () => {
    const r = repos();
    const patch = patchFor(r, (d) => writeFileSync(`${d}/crlf.txt`, "a\r\nb\r\nc\r\n"));
    const res = await real(r).pushBranch(input(r, patch));
    assert.equal(res.ok, true, JSON.stringify(res));
    const blob = showBlob(r.target, "harness/run-1:crlf.txt").toString("latin1");
    assert.equal(blob, "a\r\nb\r\nc\r\n");
  });

  test("the commit is authored by 'Cloud harness', not by whoever's git config is on this machine, and names the run", async () => {
    const r = repos();
    await real(r).pushBranch(input(r, patchFor(r, addComment), { runId: "run-42" }));
    const [name, email, , , msg = ""] = bare(r.target, "log", "-1", "--format=%an|%ae|%cn|%ce|%s", "harness/run-42").split("|");
    assert.deepEqual([name, email], ["Cloud harness", "harness@users.noreply.github.com"]);
    assert.match(msg, /run-42/);
    assert.equal(bare(r.target, "log", "-1", "--format=%cn", "harness/run-42"), "Cloud harness");
  });

  test("an unknown base commit is a stale_base failure and nothing is pushed", async () => {
    const r = repos();
    const res = failed(await real(r).pushBranch(input(r, patchFor(r, addComment), { baseCommit: "0123456789abcdef0123456789abcdef01234567" })));
    assert.equal(res.reason, "stale_base");
    assert.equal(branchSha(r), "");
  });

  test("garbage, or a patch that does not apply to the base, is a patch_failed failure and nothing is pushed", async () => {
    const r = repos();
    const good = patchFor(r, addComment);
    for (const diff of ["this is not a diff\n", good.replace("line 1", "line ONE"), good.replaceAll(FILE, "app/DoesNotExist.php")]) { // (shifted hunk line numbers alone still apply: git tolerates offsets)
      assert.equal(failed(await real(r).pushBranch(input(r, diff))).reason, "patch_failed");
    }
    assert.equal(branchSha(r), "");
  });

  test("pushing the same runId twice is a branch_exists failure that leaves the first branch untouched", async () => {
    const r = repos();
    const patch = patchFor(r, addComment);
    await real(r).pushBranch(input(r, patch));
    const first = branchSha(r);
    assert.notEqual(first, "");
    const second = failed(await real(r).pushBranch(input(r, patch)));
    assert.equal(second.reason, "branch_exists");
    assert.equal(branchSha(r), first);
  });

  test("the temporary work directory is removed after a success and after every kind of failure", async () => {
    const r = repos();
    const patch = patchFor(r, addComment);
    await real(r).pushBranch(input(r, patch, { runId: "ok-1" }));
    await real(r).pushBranch(input(r, "garbage\n", { runId: "bad-1" }));
    await real(r).pushBranch(input(r, patch, { runId: "bad-2", baseCommit: "0".repeat(40) }));
    await real(r).pushBranch(input(r, patch, { runId: "ok-1" })); // duplicate
    assert.notEqual(branchSha(r, "ok-1"), "", "the success case must really have pushed");
    assert.deepEqual(readdirSync(r.tmpRoot), []);
  });

  test("the token never appears in the log or error of a real run, on success or failure", async () => {
    const r = repos();
    const patch = patchFor(r, addComment);
    const outcomes = [await real(r).pushBranch(input(r, patch)), await real(r).pushBranch(input(r, "garbage\n", { runId: "run-2" }))];
    assert.deepEqual(outcomes.map((o) => o.ok), [true, false]);
    assert.ok(outcomes.every((o) => o.log.length > 0), "both outcomes must carry a log");
    for (const o of outcomes) assert.ok(!JSON.stringify(o).includes(TOKEN) && !JSON.stringify(o).includes(B64));
  });
});

// ====================================================================================================
// A fake git: records every call and answers from a script, so the command sequence can be asserted exactly.
type Call = { args: string[]; cwd?: string; env: Record<string, string> };
const sub = (a: string[]) => { let i = 0; while (a[i] === "-c") i += 2; return a[i]; };
const cfg = (env: Record<string, string>) => {
  const m = new Map<string, string>();
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT ?? 0); i++) m.set(env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]);
  return m;
};

function fake(script: Record<string, Partial<{ code: number; stdout: string; stderr: string }>> = {}, o: { allowLocal?: boolean } = {}) {
  const calls: Call[] = [];
  const root = mkdtempSync(join(tmpdir(), "pdf-"));
  const exec: GitExec = async (args, opts) => {
    calls.push({ args, cwd: opts.cwd, env: opts.env });
    const r = script[sub(args)] ?? {};
    const defaults = sub(args) === "rev-parse" ? { stdout: `${SHA}\n` } : {};
    return { code: 0, stdout: "", stderr: "", ...defaults, ...r };
  };
  const pd = createPatchDelivery({ exec, tmpRoot: root, allowLocal: o.allowLocal, redact: createRedactor([TOKEN]) });
  const base: PushInput = { sourceUrl: SRC, targetUrl: DST, baseCommit: SHA, diff: PATCH, runId: "run-1", token: TOKEN };
  return { calls, root, push: (i: Partial<PushInput> = {}) => pd.pushBranch({ ...base, ...i }), subs: () => calls.map((c) => sub(c.args)) };
}

describe("pushBranch command sequence (fake git)", () => {
  test("runs exactly ls-remote, clone, read-tree, apply, commit, rev-parse, push, in that order", async () => {
    const f = fake();
    const res = await f.push();
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(f.subs(), ["ls-remote", "clone", "read-tree", "apply", "commit", "rev-parse", "push"]);
    assert.deepEqual((res as any).commit, SHA);
    assert.equal((res as any).branch, "harness/run-1");
  });

  test("the push has no force of any kind and uses the exact refspec HEAD:refs/heads/harness/<runId>", async () => {
    const f = fake();
    await f.push();
    const push = f.calls.find((c) => sub(c.args) === "push")!;
    assert.ok(push, "a push call must be made");
    for (const a of push.args) assert.ok(!/^(-f|--force.*|\+.*|--mirror|--delete|--all|--tags)$/.test(a), `forbidden push arg ${a}`);
    assert.equal(push.args.at(-1), "HEAD:refs/heads/harness/run-1");
    assert.equal(push.args.at(-2), DST);
  });

  test("the clone is of the SOURCE without checkout, apply writes the index only with --binary, read-tree pins the base", async () => {
    const f = fake();
    await f.push();
    const by = (s: string) => { const c = f.calls.find((x) => sub(x.args) === s); assert.ok(c, `${s} must be called`); return c.args; };
    assert.ok(by("clone").includes("--no-checkout") && by("clone").includes(SRC));
    assert.ok(by("clone").includes("core.autocrlf=false"));
    assert.ok(by("read-tree").includes(SHA));
    assert.ok(by("apply").includes("--cached") && by("apply").includes("--binary"));
    assert.ok(by("ls-remote").includes(DST) && by("ls-remote").includes("refs/heads/harness/run-1"));
  });

  test("the patch is fed to git on stdin or a temp file inside the work dir, never spliced into argv", async () => {
    const f = fake();
    await f.push({ diff: PATCH + "+; touch /tmp/pwned $(id)\n" });
    assert.equal(f.calls.length, 7, "the full sequence must run");
    assert.ok(!JSON.stringify(f.calls.map((c) => c.args)).includes("pwned"));
  });

  test("the commit identity and message come from the environment of the commit call", async () => {
    const f = fake();
    await f.push({ runId: "run-77" });
    const c = f.calls.find((x) => sub(x.args) === "commit")!;
    assert.ok(c, "a commit call must be made");
    assert.equal(c.env.GIT_AUTHOR_NAME, "Cloud harness");
    assert.equal(c.env.GIT_COMMITTER_NAME, "Cloud harness");
    assert.equal(c.env.GIT_AUTHOR_EMAIL, "harness@users.noreply.github.com");
    assert.ok(c.args.some((a) => a.includes("run-77")));
  });

  test("after the clone, every call runs inside the temp work dir, and that dir is removed afterwards", async () => {
    const f = fake();
    await f.push();
    const after = f.calls.filter((x) => ["read-tree", "apply", "commit", "rev-parse", "push"].includes(sub(x.args)));
    assert.equal(after.length, 5);
    for (const c of after) {
      assert.ok(c.cwd && fwd(c.cwd).startsWith(fwd(f.root)), `cwd ${c.cwd}`);
    }
    assert.deepEqual(readdirSync(f.root), []);
  });
});

describe("pushBranch hardening (fake git)", () => {
  test("every call disables prompts, other protocols, system config and credential helpers", async () => {
    const f = fake();
    await f.push();
    assert.equal(f.calls.length, 7);
    for (const c of f.calls) {
      assert.equal(c.env.GIT_TERMINAL_PROMPT, "0", sub(c.args));
      assert.equal(c.env.GIT_ALLOW_PROTOCOL, "https", sub(c.args));
      assert.equal(c.env.GIT_CONFIG_NOSYSTEM, "1", sub(c.args));
      assert.equal(c.env.GIT_CONFIG_GLOBAL, "/dev/null", sub(c.args)); // not os.devNull: on Windows that is "\\\\.\\nul", which git cannot open
      assert.equal(cfg(c.env).get("credential.helper"), "", `${sub(c.args)} must reset credential.helper`);
    }
  });

  test("only the two calls that talk to the target carry the credential, scoped to github.com", async () => {
    const f = fake();
    await f.push();
    assert.equal(f.calls.length, 7);
    assert.equal(f.calls.filter((c) => cfg(c.env).has("http.https://github.com/.extraheader")).length, 2, "exactly two calls carry the credential");
    for (const c of f.calls) {
      const key = cfg(c.env).get("http.https://github.com/.extraheader");
      if (["ls-remote", "push"].includes(sub(c.args))) {
        assert.equal(key, `AUTHORIZATION: basic ${B64}`, sub(c.args));
      } else {
        assert.equal(key, undefined, `${sub(c.args)} must carry no credential`);
        assert.ok(!JSON.stringify(c.env).includes(B64) && !JSON.stringify(c.env).includes(TOKEN), `${sub(c.args)} env leaks the token`);
      }
    }
  });

  test("the token never appears in any argv of any call", async () => {
    const f = fake();
    await f.push();
    assert.equal(f.calls.length, 7);
    const argv = JSON.stringify(f.calls.map((c) => c.args));
    assert.ok(!argv.includes(TOKEN) && !argv.includes(B64));
  });

  test("a git that echoes the token in stdout and stderr cannot leak it through the log or error", async () => {
    const echo = { stdout: `remote: ${TOKEN}\nAuthorization: basic ${B64}\n`, stderr: `fatal: unable to access with ${TOKEN}\n` };
    for (const script of [{ "ls-remote": { ...echo }, push: { ...echo, code: 1 } }, { push: { ...echo, code: 1 } }, { apply: { ...echo, code: 1 } }]) {
      const f = fake(script);
      const res = failed(await f.push());
      assert.ok(res.log.length > 0, "the failure must be logged");
      const text = JSON.stringify(res);
      assert.ok(!text.includes(TOKEN) && !text.includes(B64), text);
    }
  });

  test("the log records which git step ran, so a failure can be diagnosed", async () => {
    const f = fake({ apply: { code: 1, stderr: "error: patch failed: app/X.php:5" } });
    const res = failed(await f.push());
    assert.match(res.log, /apply/);
    assert.match(res.log, /patch failed: app\/X\.php:5/);
  });
});

describe("pushBranch failure mapping (fake git)", () => {
  test("an existing remote branch stops everything before the clone", async () => {
    const f = fake({ "ls-remote": { stdout: `${SHA}\trefs/heads/harness/run-1\n` } });
    assert.equal(failed(await f.push()).reason, "branch_exists");
    assert.deepEqual(f.subs(), ["ls-remote"]);
  });

  test("an unreachable or unauthorized target is push_failed and nothing is cloned", async () => {
    const f = fake({ "ls-remote": { code: 128, stderr: "fatal: Authentication failed" } });
    const res = failed(await f.push());
    assert.equal(res.reason, "push_failed");
    assert.deepEqual(f.subs(), ["ls-remote"]);
  });

  test("a missing base commit stops at read-tree as stale_base, and a bad patch at apply as patch_failed, with no commit or push", async () => {
    const stale = fake({ "read-tree": { code: 128, stderr: "fatal: not a valid object name" } });
    assert.equal(failed(await stale.push()).reason, "stale_base");
    assert.deepEqual(stale.subs(), ["ls-remote", "clone", "read-tree"]);
    const bad = fake({ apply: { code: 1, stderr: "error: patch does not apply" } });
    assert.equal(failed(await bad.push()).reason, "patch_failed");
    assert.deepEqual(bad.subs(), ["ls-remote", "clone", "read-tree", "apply"]);
  });

  test("a push rejected because the branch appeared meanwhile is branch_exists, any other rejection is push_failed", async () => {
    const raced = fake({ push: { code: 1, stderr: " ! [rejected]        HEAD -> harness/run-1 (non-fast-forward)" } });
    assert.equal(failed(await raced.push()).reason, "branch_exists");
    const denied = fake({ push: { code: 128, stderr: "remote: Permission to johnsiega/x denied" } });
    assert.equal(failed(await denied.push()).reason, "push_failed");
  });

  test("a failing clone of the source is push_failed, and the work dir is still removed", async () => {
    const f = fake({ clone: { code: 128, stderr: "fatal: repository not found" } });
    assert.equal(failed(await f.push()).reason, "push_failed");
    assert.deepEqual(readdirSync(f.root), []);
  });

  test("an exec that throws is reported as a failure, never as an unhandled rejection, and still cleans up", async () => {
    const root = mkdtempSync(join(tmpdir(), "pdt-"));
    const pd = createPatchDelivery({ exec: async () => { throw new Error(`spawn failed with ${TOKEN}`); }, tmpRoot: root, redact: createRedactor([TOKEN]) });
    const res = failed(await pd.pushBranch({ sourceUrl: SRC, targetUrl: DST, baseCommit: SHA, diff: PATCH, runId: "run-1", token: TOKEN }));
    assert.equal(res.reason, "push_failed");
    assert.ok(!JSON.stringify(res).includes(TOKEN));
    assert.deepEqual(readdirSync(root), []);
  });
});

describe("pushBranch input validation (fake git: nothing may run)", () => {
  const rejects = async (over: Partial<PushInput>, reason = "invalid_input", opts: { allowLocal?: boolean } = {}) => {
    const f = fake({}, opts);
    const res = failed(await f.push(over));
    assert.equal(res.reason, reason, JSON.stringify(over).slice(0, 90));
    assert.equal(f.calls.length, 0, "git must not run for invalid input");
    assert.ok(!existsSync(join(f.root, "x")));
  };

  test("a base commit must be exactly 40 lowercase hex characters", async () => {
    for (const baseCommit of ["", "ea724ce", SHA.toUpperCase(), "z".repeat(40), "--upload-pack=x", SHA + "a", SHA + "\n", `${SHA} --force`]) await rejects({ baseCommit });
  });

  test("a runId must be a simple token: no slashes, dots, spaces, newlines, leading dash, or more than 64 characters", async () => {
    for (const runId of ["", "../main", "a/b", "a b", "x;y", "-flag", "a".repeat(65), "run\n1", "..", "run.1", "ref@{0}", "run:1"]) await rejects({ runId });
  });

  test("ordinary ids and UUIDs are accepted", async () => {
    for (const runId of ["run-1", "Run-7", "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"]) {
      const f = fake();
      assert.equal((await f.push({ runId })).ok, true, runId);
      assert.equal(f.calls.length, 7, `${runId}: the full sequence must run`);
    }
  });

  test("an empty or whitespace-only diff is refused", async () => {
    for (const diff of ["", "  \n\t\n"]) await rejects({ diff });
  });

  test("a diff that went through redaction is refused with its own reason, never pushed altered", async () => {
    await rejects({ diff: PATCH.replace("harness", "[REDACTED]") }, "redacted_diff");
  });

  test("an empty or whitespace token is refused", async () => {
    for (const token of ["", "   ", "\n"]) await rejects({ token });
  });

  test("by default only https://github.com/<owner>/<repo> is accepted for source and target", async () => {
    const bad = ["/tmp/repo", "C:/repo", "ext::sh -c touch /tmp/pwned", "--upload-pack=touch /tmp/x", "-oProxyCommand=x", "http://github.com/a/b", "https://evil.example/a/b", "https://github.com.evil.example/a/b", "https://github.com@evil.example/a/b", "git@github.com:a/b.git", "file:///etc/passwd", "ssh://github.com/a/b", ""];
    for (const url of bad) {
      await rejects({ sourceUrl: url });
      await rejects({ targetUrl: url });
    }
  });

  test("allowLocal permits absolute local paths for tests but still refuses ext:: transports and option-like values", async () => {
    const f = fake({}, { allowLocal: true });
    assert.equal((await f.push({ sourceUrl: "/tmp/source", targetUrl: "/tmp/target.git" })).ok, true);
    assert.equal(f.calls.length, 7, "local paths must be accepted with allowLocal");
    for (const url of ["ext::sh -c x", "--upload-pack=x", "-x", "fd::3", "relative/path"]) {
      await rejects({ sourceUrl: url }, "invalid_input", { allowLocal: true });
      await rejects({ targetUrl: url }, "invalid_input", { allowLocal: true });
    }
  });

  test("with allowLocal the protocol allow-list widens to file only, never to ext", async () => {
    const f = fake({}, { allowLocal: true });
    await f.push({ sourceUrl: "/tmp/source", targetUrl: "/tmp/target.git" });
    assert.equal(f.calls.length, 7);
    for (const c of f.calls) assert.equal(c.env.GIT_ALLOW_PROTOCOL, "https:file");
  });
});
