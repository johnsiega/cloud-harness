// GitHub REST client with a fake fetch: nothing here reaches the network. Run: node --test tests/unit/github-pr.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildPrText, createGithubPrs, describeTests } from "../../api/github-pr.ts";
import type { FetchLike, TraceEvent } from "../../api/types.ts";

const TOKEN = "github_pat_11PRCLIENTTOKEN_abcdefghijklmnopqrstuvwxyz0123456789";
const SLUG = "johnsiega/goats-hsw-rag-chatbot";
type Call = { url: string; init: any };

function fake(answer: (c: Call) => { status: number; body?: unknown } | Error) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const c = { url, init };
    calls.push(c);
    const a = answer(c);
    if (a instanceof Error) throw a;
    return { ok: a.status < 300, status: a.status, json: async () => a.body, text: async () => JSON.stringify(a.body ?? "") };
  };
  return { calls, gh: createGithubPrs({ token: TOKEN, fetch }) };
}
const PR_IN = { slug: SLUG, head: "harness/run-1", base: "develop", title: "harness: t", body: "b" };
const CREATED = { status: 201, body: { number: 7, html_url: `https://github.com/${SLUG}/pull/7` } };

describe("defaultBranch", () => {
  test("GETs /repos/<slug> on api.github.com with the auth, accept, version and user-agent headers, and returns default_branch", async () => {
    const f = fake(() => ({ status: 200, body: { default_branch: "develop" } }));
    assert.deepEqual(await f.gh.defaultBranch(SLUG), { ok: true, value: "develop" });
    assert.ok(f.calls[0], "a request must be made"); // keeps the red run an assertion, not a TypeError
    assert.equal(f.calls[0].url, `https://api.github.com/repos/${SLUG}`);
    assert.equal(f.calls[0].init.method ?? "GET", "GET");
    assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(f.calls[0].init.headers.Accept, "application/vnd.github+json");
    assert.equal(f.calls[0].init.headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.equal(f.calls[0].init.headers["User-Agent"], "cloud-harness");
    assert.ok(f.calls[0].init.signal, "every request has a deadline");
  });
  test("a missing or odd default_branch is pr_failed; an invalid slug makes no request at all", async () => {
    assert.equal((await fake(() => ({ status: 200, body: {} })).gh.defaultBranch(SLUG)).ok, false);
    assert.equal((await fake(() => ({ status: 200, body: { default_branch: "a b;rm" } })).gh.defaultBranch(SLUG)).ok, false);
    const f = fake(() => ({ status: 200, body: { default_branch: "main" } }));
    assert.deepEqual(await f.gh.defaultBranch("../evil"), { ok: false, reason: "pr_failed", error: "invalid repo name" });
    assert.equal(f.calls.length, 0);
  });
});

describe("openDraft", () => {
  test("POSTs /repos/<slug>/pulls with title, head, base, body and draft: true, and returns number and url", async () => {
    const f = fake(() => CREATED);
    assert.deepEqual(await f.gh.openDraft(PR_IN), { ok: true, value: { number: 7, url: `https://github.com/${SLUG}/pull/7` } });
    assert.ok(f.calls[0], "a request must be made");
    assert.equal(f.calls[0].url, `https://api.github.com/repos/${SLUG}/pulls`);
    assert.equal(f.calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { title: "harness: t", head: "harness/run-1", base: "develop", body: "b", draft: true });
  });
  test("draft is always true, even if a caller smuggles a draft field in", async () => {
    const f = fake(() => CREATED);
    await f.gh.openDraft({ ...PR_IN, draft: false } as any);
    assert.ok(f.calls[0], "a request must be made");
    assert.equal(JSON.parse(f.calls[0].init.body).draft, true);
  });
  test("a 201 without a numeric number or with a non-GitHub url is pr_failed", async () => {
    for (const body of [{ html_url: `https://github.com/${SLUG}/pull/7` }, { number: "7", html_url: "x" }, { number: 7, html_url: "https://evil.example/pull/7" }]) {
      const f = fake(() => ({ status: 201, body }));
      const r = await f.gh.openDraft(PR_IN);
      assert.equal(f.calls.length, 1, "the request must have been made");
      assert.equal(r.ok, false, JSON.stringify(body));
      assert.equal(!r.ok && r.reason, "pr_failed", JSON.stringify(body)); // not the stub's "stub" error: the real validation
    }
  });
});

describe("error mapping (both calls)", () => {
  const cases: [number | Error, string, RegExp][] = [
    [401, "pr_unauthorized", /invalid or expired/],
    [403, "pr_forbidden", /lacks permission/],
    [404, "pr_not_found", /repo or token scope is wrong/],
    [422, "pr_unprocessable", /already exists or there is nothing to compare/],
    [500, "pr_failed", /HTTP 500/],
    [new TypeError(`fetch failed ${TOKEN}`), "pr_unreachable", /could not reach GitHub/],
    [Object.assign(new Error(`timed out ${TOKEN}`), { name: "TimeoutError" }), "pr_unreachable", /could not reach GitHub/],
  ];
  for (const [answer, reason, msg] of cases) {
    test(`${answer instanceof Error ? answer.name : answer} → ${reason}, and the message never contains the token`, async () => {
      const f = fake(() => (answer instanceof Error ? answer : { status: answer, body: { message: `nope ${TOKEN}` } }));
      for (const r of [await f.gh.defaultBranch(SLUG), await f.gh.openDraft(PR_IN)]) {
        assert.equal(r.ok, false);
        if (r.ok) continue;
        assert.equal(r.reason, reason);
        assert.match(r.error, msg);
        assert.ok(!JSON.stringify(r).includes(TOKEN));
      }
    });
  }
  test("every request goes to https://api.github.com only", async () => {
    const f = fake(() => CREATED);
    await f.gh.defaultBranch(SLUG);
    await f.gh.openDraft(PR_IN);
    assert.equal(f.calls.length, 2, "both calls must have made a request");
    assert.ok(f.calls.every((c) => c.url.startsWith("https://api.github.com/")));
  });
});

describe("describeTests", () => {
  const tr = (exitCode: number, skipped?: string): TraceEvent => ({ type: "test_result", ts: 1, exitCode, summary: "", ...(skipped ? { skipped } : {}) });
  test("passed, not run with its reason, failed with the exit code, and not reported", () => {
    assert.equal(describeTests([tr(0)]), "passed");
    assert.equal(describeTests([tr(0, "no tests found")]), "not run (no tests found)");
    assert.equal(describeTests([tr(2)]), "failed (exit 2)");
    assert.equal(describeTests([{ type: "done", ts: 1, exitCode: 0 }]), "not reported");
  });
  test("the last test_result wins", () => {
    assert.equal(describeTests([tr(1), tr(0)]), "passed");
  });
});

describe("buildPrText", () => {
  const base = { runId: "run-1", model: "deepseek/deepseek-v4.1-flash", tests: "not run (no tests found)" };
  test("title is 'harness: ' plus the first 60 characters of the task, with whitespace collapsed", () => {
    const task = "Add a one-line comment\n\nat the top of app.py " + "x".repeat(80);
    const { title } = buildPrText({ ...base, task });
    assert.equal(title, "harness: " + task.replace(/\s+/g, " ").trim().slice(0, 60));
    assert.ok(!title.includes("\n"));
  });
  test("body carries the task, run id, model, test outcome and the review notice", () => {
    const { body } = buildPrText({ ...base, task: "Add a comment" });
    for (const s of ["Add a comment", "run-1", "deepseek/deepseek-v4.1-flash", "not run (no tests found)", "Generated by Cloud harness. Review before merging."]) {
      assert.ok(body.includes(s), s);
    }
  });
  test("the task sits inside a fence that it cannot close, so @mentions and markdown stay inert (R3)", () => {
    const task = "ping @someone\n~~~\n![x](https://evil.example/x.png)";
    const { body } = buildPrText({ ...base, task });
    const fence = body.match(/^(~{3,})text$/m)?.[1];
    assert.ok(fence && fence.length > 3, "the fence must be longer than any ~ run in the task");
    const inside = body.split(fence + "text\n")[1].split("\n" + fence + "\n")[0];
    assert.equal(inside, task);
  });
});
