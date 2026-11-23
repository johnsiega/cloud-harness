// Patch delivery: apply a captured diff to a fresh clone at the run's base commit and push it as harness/<runId>.
// The sandbox is gone by now and the push token must never enter it, so this runs in the control plane.
//   ls-remote (target) -> clone SOURCE at the base commit -> read-tree -> apply --cached --binary -> commit -> rev-parse -> push (target)
// The token is sent only on the two calls that talk to the target, only via GIT_CONFIG_* env (never argv or a URL), and
// every byte of git output is redacted before it is returned.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor } from "./redact.ts";
import type { Redactor } from "./types.ts";

export type GitResult = { code: number; stdout: string; stderr: string };
export type GitExec = (args: string[], o: { cwd?: string; env: Record<string, string> }) => Promise<GitResult>;

export type PushInput = {
  sourceUrl: string; // where the run's code came from (public); cloned without credentials
  targetUrl: string; // where the branch goes (private); the only place the token is ever sent
  baseCommit: string;
  diff: string;
  runId: string;
  token: string;
};

export type PushFailure = "invalid_input" | "redacted_diff" | "branch_exists" | "stale_base" | "patch_failed" | "push_failed";
export type PushResult = { ok: true; branch: string; commit: string; log: string } | { ok: false; reason: PushFailure; error: string; log: string };

const defaultExec: GitExec = (args, o) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd: o.cwd, env: o.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = (err as { code?: unknown } | null)?.code;
      if (err && typeof code !== "number") return reject(err); // could not even start git
      resolve({ code: err ? (code as number) : 0, stdout, stderr });
    });
  });

const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
const LOCAL_PATH = /^(?:[A-Za-z]:)?\//; // absolute only; used by tests
const SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const IDENTITY = { name: "Cloud harness", email: "harness@users.noreply.github.com" };
const PASS_THROUGH_ENV = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG"];
const NOT_AT_BASE = /could not parse|not our ref|couldn't find remote ref|unadvertised|no such (ref|object)|bad object|invalid revision|not a valid object|remote ref/i;
const BRANCH_TAKEN = /non-fast-forward|already exists|fetch first|\[rejected\]/i;

export function createPatchDelivery(o: { exec?: GitExec; allowLocal?: boolean; redact?: Redactor; tmpRoot?: string } = {}) {
  const exec = o.exec ?? defaultExec;
  const allowLocal = o.allowLocal ?? false;

  const urlOk = (u: string) => {
    if (typeof u !== "string" || u.startsWith("-") || u.includes("::") || /[\s\0]/.test(u)) return false;
    return GITHUB_URL.test(u.replace(/\.git$/, "")) || (allowLocal && LOCAL_PATH.test(u));
  };

  return {
    async pushBranch(input: PushInput): Promise<PushResult> {
      const { sourceUrl, targetUrl, baseCommit, diff, runId, token } = input;
      const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
      const scrub = createRedactor([token, Buffer.from(`x-access-token:${token}`).toString("base64"), header]);
      const clean = (s: string) => (o.redact ?? scrub).text(scrub.text(s));
      const log: string[] = [];
      const fail = (reason: PushFailure, error: string): PushResult => ({ ok: false, reason, error: clean(error), log: log.join("\n") });

      if (!urlOk(sourceUrl) || !urlOk(targetUrl)) return fail("invalid_input", "source and target must be https://github.com/<owner>/<repo> URLs");
      if (typeof baseCommit !== "string" || !SHA.test(baseCommit)) return fail("invalid_input", "baseCommit must be 40 lowercase hex characters");
      if (typeof runId !== "string" || !RUN_ID.test(runId)) return fail("invalid_input", "runId must be a simple token (letters, digits, dashes)");
      if (typeof diff !== "string" || diff.trim() === "") return fail("invalid_input", "the diff is empty");
      if (diff.includes("[REDACTED]")) return fail("redacted_diff", "the stored diff was altered by redaction; refusing to push modified content");
      if (typeof token !== "string" || token.trim() === "" || /\s/.test(token)) return fail("invalid_input", "a push token is required");

      const branch = `harness/${runId}`;
      const base: Record<string, string> = {};
      for (const k of PASS_THROUGH_ENV) if (process.env[k] !== undefined) base[k] = process.env[k]!;

      // Hardened environment for every call; the credential is attached only when `auth` is true.
      const env = (auth: boolean, extra: Record<string, string> = {}): Record<string, string> => {
        const config: [string, string][] = [["credential.helper", ""], ["core.autocrlf", "false"], ["core.safecrlf", "false"]];
        if (auth) config.push(["http.https://github.com/.extraheader", header]);
        const e: Record<string, string> = {
          ...base, ...extra,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ALLOW_PROTOCOL: allowLocal ? "https:file" : "https",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null", // git maps this to the null device on every OS; node's os.devNull ("\\\\.\\nul") is unreadable to git on Windows
          GIT_CONFIG_COUNT: String(config.length),
        };
        config.forEach(([k, v], i) => { e[`GIT_CONFIG_KEY_${i}`] = k; e[`GIT_CONFIG_VALUE_${i}`] = v; });
        return e;
      };

      const sub = (a: string[]) => { let i = 0; while (a[i] === "-c") i += 2; return a[i]; };
      const git = async (args: string[], cwd: string | undefined, auth: boolean, extra?: Record<string, string>): Promise<GitResult> => {
        const r = await exec(args, { cwd, env: env(auth, extra) });
        const out = [r.stdout, r.stderr].map((s) => s.trim()).filter(Boolean).join("\n");
        log.push(clean(`git ${sub(args)} (exit ${r.code})${out ? `\n${out}` : ""}`));
        return r;
      };

      let work: string | undefined;
      try {
        const remote = await git(["ls-remote", "--", targetUrl, `refs/heads/${branch}`], undefined, true);
        if (remote.code !== 0) return fail("push_failed", "could not reach the target repository (check the token and the repo name)");
        if (remote.stdout.trim() !== "") return fail("branch_exists", `${branch} already exists in the target; refusing to overwrite`);

        work = await mkdtemp(join(o.tmpRoot ?? tmpdir(), "hq-push-"));
        const repo = join(work, "repo");

        // --revision checks out detached at exactly the base commit, so the new commit's parent is the base, not the source's tip.
        const clone = await git(["-c", "core.autocrlf=false", "clone", "-q", "--no-checkout", "--revision", baseCommit, "--", sourceUrl, repo], work, false);
        if (clone.code !== 0) return NOT_AT_BASE.test(clone.stderr) ? fail("stale_base", "the base commit is no longer available in the source repository") : fail("push_failed", "could not clone the source repository");

        const tree = await git(["read-tree", baseCommit], repo, false);
        if (tree.code !== 0) return fail("stale_base", "the base commit is not in the cloned repository");

        const patchFile = join(work, "patch.diff");
        await writeFile(patchFile, diff.endsWith("\n") ? diff : diff + "\n");
        const apply = await git(["apply", "--cached", "--binary", "--whitespace=nowarn", patchFile], repo, false);
        if (apply.code !== 0) return fail("patch_failed", "the patch does not apply cleanly to the base commit");

        const commit = await git(["commit", "-q", "--no-verify", "-m", `Cloud harness run ${runId}`], repo, false, {
          GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email,
        });
        if (commit.code !== 0) return fail("patch_failed", "the patch produced no changes to commit");

        const head = await git(["rev-parse", "HEAD"], repo, false);
        const sha = head.stdout.trim();
        if (head.code !== 0 || !SHA.test(sha)) return fail("push_failed", "could not read the new commit");

        // No force of any kind: a branch that appeared meanwhile is rejected, never overwritten.
        const push = await git(["push", "--", targetUrl, `HEAD:refs/heads/${branch}`], repo, true);
        if (push.code !== 0) return BRANCH_TAKEN.test(push.stderr) ? fail("branch_exists", `${branch} already exists in the target; refusing to overwrite`) : fail("push_failed", "the push was rejected by the target repository");

        return { ok: true, branch, commit: sha, log: log.join("\n") };
      } catch (e) {
        return fail("push_failed", e instanceof Error ? e.message : String(e));
      } finally {
        if (work) await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
      }
    },
  };
}
