// POST /runs/:id/pr and /config with fake delivery and a fake GitHub: nothing here pushes or calls GitHub.
// Run: node --test tests/unit/pr-route.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../api/server.ts";
import { createRunStore } from "../../api/run-store.ts";
import { createRedactor } from "../../api/redact.ts";
import type { PushInput, PushResult } from "../../api/patch-delivery.ts";
import type { GithubPrs, GhResult } from "../../api/github-pr.ts";

const PR_TOKEN = "github_pat_11PRROUTETOKEN_abcdefghijklmnopqrstuvwxyz0123456789";
const PUSH_TOKEN = "github_pat_11PUSHTOKEN_abcdefghijklmnopqrstuvwxyz0123456789";
const KEY = "sk-or-v1-PRROUTEKEY-0123456789";
const REPO = "https://github.com/johnsiega/goats-hsw-rag-chatbot";
const SLUG = "johnsiega/goats-hsw-rag-chatbot";
const SHA = "ea724cea11c755453e8d826872470b2448c1cca1";
const COMMIT = "c".repeat(40);
const DIFF = "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1 +1,2 @@\n+# x\n a\n";
const PR_URL = `https://github.com/${SLUG}/pull/7`;

async function json(res: Response): Promise<any> {
  const t = await res.text();
  try { return JSON.parse(t); } catch { assert.fail(`expected a JSON body, got: ${t.slice(0, 60)}`); }
}

type Opts = {
  configured?: boolean; repoUrl?: string; task?: string; status?: any; diff?: string | null; baseCommit?: string | null;
  deliver?: (i: PushInput) => Promise<PushResult>;
  defaultBranch?: () => Promise<GhResult<string>>;
  openDraft?: (i: any) => Promise<GhResult<{ number: number; url: string }>>;
  demo?: boolean;
};

function setup(o: Opts = {}) {
  let n = 0;
  const store = createRunStore({ now: () => 1000, ttlMs: 1e9, newId: () => `run-${++n}` });
  const log: string[] = [];
  const delivered: PushInput[] = [];
  const opened: any[] = [];
  const github: GithubPrs = {
    defaultBranch: async (slug) => { log.push(`defaultBranch ${slug}`); return o.defaultBranch ? o.defaultBranch() : { ok: true, value: "develop" }; },
    openDraft: async (i) => { log.push("openDraft"); opened.push(i); return o.openDraft ? o.openDraft(i) : { ok: true, value: { number: 7, url: PR_URL } }; },
  };
  const deliver = async (i: PushInput): Promise<PushResult> => {
    log.push("deliver"); delivered.push(i);
    return o.deliver ? o.deliver(i) : { ok: true, branch: "harness/run-1", commit: COMMIT, log: "" };
  };
  const app = createApp({
    store, startRun: () => {}, redact: createRedactor([KEY, PUSH_TOKEN, PR_TOKEN]),
    ...(o.demo ? { demo: { reason: "no key" } } : {}),
    push: { token: PUSH_TOKEN, targetUrl: "https://github.com/johnsiega/hospital-queue-harness", deliver: async () => ({ ok: false, reason: "push_failed", error: "must not be called", log: "" }) },
    ...(o.configured === false ? {} : { pr: { repos: [SLUG], token: PR_TOKEN, deliver, github } }),
  });
  store.create({ repoUrl: o.repoUrl ?? REPO, task: o.task ?? "Add a one-line comment at the top of app.py" });
  store.update("run-1", { status: o.status ?? "done" });
  if (o.diff !== null) store.update("run-1", { diff: o.diff ?? DIFF });
  if (o.baseCommit !== null) store.update("run-1", { baseCommit: o.baseCommit ?? SHA });
  store.append("run-1", { type: "test_result", ts: 1, exitCode: 0, summary: "tests not run: no tests found", skipped: "no tests found" });
  const pr = (id = "run-1", headers: Record<string, string> = {}) =>
    app.request(`/runs/${id}/pr`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
  return { app, store, log, delivered, opened, pr };
}

describe("POST /runs/:id/pr: success", () => {
  test("200 with number, url and branch; the run stores the PR", async () => {
    const s = setup();
    const res = await s.pr();
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { number: 7, url: PR_URL, branch: "harness/run-1" });
    assert.deepEqual(s.store.get("run-1")?.pr, { branch: "harness/run-1", commit: COMMIT, number: 7, url: PR_URL });
  });
  test("order: default branch first (no push if the token cannot even see the repo), then the push, then the PR", async () => {
    const s = setup();
    await s.pr();
    assert.deepEqual(s.log, [`defaultBranch ${SLUG}`, "deliver", "openDraft"]);
  });
  test("the push targets the run's own repo with the PR token (never the push token), at the stored base commit", async () => {
    const s = setup();
    await s.pr();
    assert.deepEqual(s.delivered, [{ sourceUrl: REPO, targetUrl: REPO, baseCommit: SHA, diff: DIFF, runId: "run-1", token: PR_TOKEN }]);
  });
  test("the PR goes from harness/<runId> into the repo's default branch as read from GitHub, not an assumed main", async () => {
    const s = setup();
    await s.pr();
    assert.ok(s.opened[0], "a PR must be opened");
    assert.equal(s.opened[0].slug, SLUG);
    assert.equal(s.opened[0].head, "harness/run-1");
    assert.equal(s.opened[0].base, "develop");
    assert.equal(s.opened[0].title, "harness: Add a one-line comment at the top of app.py");
    assert.ok(s.opened[0].body.includes("not run (no tests found)"));
  });
});

describe("POST /runs/:id/pr: refusals (nothing is pushed, GitHub is not called)", () => {
  const nothing = (s: ReturnType<typeof setup>) => assert.deepEqual(s.log, []);
  test("unknown run: 404", async () => { const s = setup(); assert.equal((await s.pr("nope")).status, 404); nothing(s); });
  test("feature not configured: 503 naming PR_REPOS and GIT_PR_TOKEN", async () => {
    const s = setup({ configured: false });
    const res = await s.pr();
    assert.equal(res.status, 503);
    assert.match((await json(res)).error, /PR_REPOS.*GIT_PR_TOKEN/);
  });
  test("a repo outside the allowlist, including a look-alike: 403", async () => {
    for (const repoUrl of ["https://github.com/jyvnn/hospital-queue", `${REPO}2`, "https://github.com/someone/goats-hsw-rag-chatbot"]) {
      const s = setup({ repoUrl });
      assert.equal((await s.pr()).status, 403, repoUrl);
      nothing(s);
    }
  });
  test("an allowlisted repo in another letter case or with .git is accepted", async () => {
    assert.equal((await setup({ repoUrl: "https://github.com/JohnSiega/goats-hsw-rag-chatbot.git" }).pr()).status, 200);
  });
  test("a run that is not done: 409; no diff or no base commit: 400", async () => {
    for (const status of ["running", "pending", "error"]) { const s = setup({ status }); assert.equal((await s.pr()).status, 409, status); nothing(s); }
    for (const o of [{ diff: null }, { diff: "  " }, { baseCommit: null }] as Opts[]) { const s = setup(o); assert.equal((await s.pr()).status, 400); nothing(s); }
  });
  test("guarded like every route: a cross-site Origin gets 403, a text/plain POST gets 415, demo mode gets 503", async () => {
    const s = setup();
    assert.equal((await s.pr("run-1", { origin: "https://evil.example" })).status, 403);
    assert.equal((await s.app.request("/runs/run-1/pr", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await setup({ demo: true }).pr()).status, 503);
    nothing(s);
  });
});

describe("POST /runs/:id/pr: one PR per run", () => {
  test("a second request answers 409 with the existing number, url and branch, and pushes nothing", async () => {
    const s = setup();
    assert.equal((await s.pr()).status, 200, "the first request must succeed");
    const res = await s.pr();
    assert.equal(res.status, 409);
    assert.deepEqual(await json(res), { error: "this run already has a pull request", number: 7, url: PR_URL, branch: "harness/run-1" });
    assert.equal(s.delivered.length, 1);
  });
  test("two requests at once: one 200, one 409, one push", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const s = setup({ deliver: async () => { await gate; return { ok: true, branch: "harness/run-1", commit: COMMIT, log: "" }; } });
    const a = s.pr(); const b = s.pr();
    await new Promise((r) => setTimeout(r, 10)); release();
    assert.deepEqual([(await a).status, (await b).status].sort(), [200, 409]);
    assert.equal(s.delivered.length, 1);
  });
  test("an existing branch (from delivery) answers 409 branch_exists and no PR is opened", async () => {
    const s = setup({ deliver: async () => ({ ok: false, reason: "branch_exists", error: "harness/run-1 already exists", log: "" }) });
    const res = await s.pr();
    assert.equal(res.status, 409);
    assert.equal((await json(res)).reason, "branch_exists");
    assert.ok(s.log.includes("deliver"), "delivery must have been attempted");
    assert.ok(!s.log.includes("openDraft"));
  });
});

describe("POST /runs/:id/pr: GitHub failures", () => {
  test("default-branch 403 → 502 pr_forbidden, and nothing is pushed", async () => {
    const s = setup({ defaultBranch: async () => ({ ok: false, reason: "pr_forbidden", error: "the token lacks permission for this repo" }) });
    const res = await s.pr();
    assert.equal(res.status, 502);
    assert.equal((await json(res)).reason, "pr_forbidden");
    assert.ok(s.log.includes(`defaultBranch ${SLUG}`), "the default branch must have been asked for");
    assert.equal(s.delivered.length, 0);
  });
  test("PR 422 → 409 pr_unprocessable, with no branch in the body (so the UI never shows it as success)", async () => {
    const s = setup({ openDraft: async () => ({ ok: false, reason: "pr_unprocessable", error: "a pull request already exists or there is nothing to compare" }) });
    const res = await s.pr();
    assert.equal(res.status, 409);
    const body = await json(res);
    assert.equal(body.reason, "pr_unprocessable");
    assert.equal(body.branch, undefined);
  });
  test("R1: after the branch was pushed but the PR call failed, a retry opens the PR without pushing again", async () => {
    let fails = 1;
    const s = setup({ openDraft: async () => (fails-- > 0 ? { ok: false, reason: "pr_unreachable", error: "could not reach GitHub" } : { ok: true, value: { number: 8, url: `https://github.com/${SLUG}/pull/8` } }) });
    assert.equal((await s.pr()).status, 502);
    assert.deepEqual(s.store.get("run-1")?.pr, { branch: "harness/run-1", commit: COMMIT });
    const res = await s.pr();
    assert.equal(res.status, 200);
    assert.equal((await json(res)).number, 8);
    assert.equal(s.delivered.length, 1, "the branch is pushed once");
  });
});

describe("POST /runs/:id/pr: secrets", () => {
  test("a secret in the task never reaches GitHub: the title and body are redacted", async () => {
    const s = setup({ task: `use ${KEY} and ${PR_TOKEN} please` });
    await s.pr();
    assert.ok(s.opened[0], "a PR must be opened");
    const sent = JSON.stringify(s.opened);
    assert.ok(!sent.includes(KEY) && !sent.includes(PR_TOKEN), sent);
    assert.ok(sent.includes("[REDACTED]"));
  });
  test("no error response ever contains the PR token", async () => {
    // Status and reason first, so these checks cannot pass against a stub that never reaches the failing call.
    const leaky = setup({ deliver: async () => ({ ok: false, reason: "push_failed", error: `denied ${PR_TOKEN}`, log: `git push ${PR_TOKEN}` }) });
    const r1 = await leaky.pr();
    const t1 = await r1.text();
    assert.equal(r1.status, 502);
    assert.equal(JSON.parse(t1).reason, "push_failed");
    assert.ok(!t1.includes(PR_TOKEN), t1);
    const leaky2 = setup({ openDraft: async () => ({ ok: false, reason: "pr_failed", error: `bad ${PR_TOKEN}` }) });
    const r2 = await leaky2.pr();
    const t2 = await r2.text();
    assert.equal(r2.status, 502);
    assert.equal(JSON.parse(t2).reason, "pr_failed");
    assert.ok(!t2.includes(PR_TOKEN), t2);
  });
});

describe("GET /config with draft PRs", () => {
  test("lists the allowlisted repos (names only) next to the push settings, never a token", async () => {
    const res = await setup().app.request("/config");
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { pushEnabled: true, pushTarget: "johnsiega/hospital-queue-harness", prRepos: [SLUG] });
    assert.ok(!text.includes(PR_TOKEN) && !text.includes(PUSH_TOKEN));
  });
  test("without the PR feature the response has no prRepos key at all", async () => {
    const body = JSON.parse(await (await setup({ configured: false }).app.request("/config")).text());
    assert.deepEqual(body, { pushEnabled: true, pushTarget: "johnsiega/hospital-queue-harness" });
  });
});
