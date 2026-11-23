// UI state behind the push button: when it shows, what each outcome looks like, what the user is told on failure.
// Run: node --test tests/unit/push-state.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canPush, initialPush, pushErrorMessage, pushLabel, reducePush, shortSha, type PushState } from "../../web/src/push-state.ts";
import { initialView, reduce } from "../../web/src/run-view.ts";
import type { TraceEvent } from "../../api/types.ts";

const DIFF = "diff --git a/f b/f\n+x\n";
const play = (events: TraceEvent[]) => events.reduce(reduce, initialView());
const FINISHED = play([
  { type: "sandbox_resuming", ts: 1 }, { type: "sandbox_ready", ts: 2, startupMs: 1 },
  { type: "reasoning", ts: 3, text: "x" }, { type: "test_result", ts: 4, exitCode: 0, summary: "tests passed" },
  { type: "diff", ts: 5, diff: DIFF }, { type: "done", ts: 6, exitCode: 0 },
]);
const ON = { pushEnabled: true, pushTarget: "johnsiega/hospital-queue-harness" };
const OK = { type: "success", branch: "harness/run-1", commit: "b".repeat(40), url: "https://github.com/johnsiega/hospital-queue-harness/tree/harness/run-1" } as const;

describe("initialPush", () => {
  test("starts idle with nothing recorded", () => {
    assert.deepEqual(initialPush(), { status: "idle" });
  });
});

describe("canPush", () => {
  test("is true only for a successfully finished run with a diff, when push is configured and the run id is known", () => {
    assert.equal(canPush(FINISHED, ON, "run-1"), true);
  });

  test("is false when push is not configured, the config has not loaded, or there is no run id", () => {
    assert.equal(canPush(FINISHED, { pushEnabled: false }, "run-1"), false);
    assert.equal(canPush(FINISHED, undefined, "run-1"), false);
    assert.equal(canPush(FINISHED, ON, undefined), false);
    assert.equal(canPush(FINISHED, ON, ""), false);
  });

  test("is false while the run is still going, and for a run that ended in error", () => {
    const running = play([{ type: "sandbox_resuming", ts: 1 }, { type: "sandbox_ready", ts: 2, startupMs: 1 }, { type: "diff", ts: 3, diff: DIFF }]);
    assert.equal(canPush(running, ON, "run-1"), false);
    const errored = play([{ type: "diff", ts: 3, diff: DIFF }, { type: "done", ts: 4, exitCode: 1 }]);
    assert.equal(canPush(errored, ON, "run-1"), false);
    assert.equal(canPush(initialView(), ON, "run-1"), false);
  });

  test("is false when the diff is missing, empty or whitespace", () => {
    for (const diff of [undefined, "", "  \n"]) {
      const v = play([...(diff === undefined ? [] : [{ type: "diff", ts: 1, diff } as TraceEvent]), { type: "done", ts: 2, exitCode: 0 }]);
      assert.equal(canPush(v, ON, "run-1"), false, JSON.stringify(diff));
    }
  });
});

describe("reducePush", () => {
  test("start moves idle or failed to pushing and clears the old error", () => {
    assert.deepEqual(reducePush({ status: "idle" }, { type: "start" }), { status: "pushing" });
    assert.deepEqual(reducePush({ status: "failed", error: "old" }, { type: "start" }), { status: "pushing" });
  });

  test("start while already pushing, or after a successful push, changes nothing (no double submit)", () => {
    const pushing: PushState = { status: "pushing" };
    assert.deepEqual(reducePush(pushing, { type: "start" }), pushing);
    const pushed: PushState = { status: "pushed", branch: "harness/run-1", commit: "c", url: "u" };
    assert.deepEqual(reducePush(pushed, { type: "start" }), pushed);
  });

  test("success records the branch, commit and link", () => {
    assert.deepEqual(reducePush({ status: "pushing" }, OK), { status: "pushed", branch: OK.branch, commit: OK.commit, url: OK.url });
  });

  test("a 409 that names an existing branch is shown as pushed, not as an error (the run was already pushed)", () => {
    const s = reducePush({ status: "pushing" }, { type: "failure", status: 409, body: { error: "this run was already pushed", branch: "harness/run-1", url: "https://github.com/o/r/tree/harness/run-1" } });
    assert.equal(s.status, "pushed");
    assert.equal(s.branch, "harness/run-1");
    assert.equal(s.url, "https://github.com/o/r/tree/harness/run-1");
    assert.equal(s.error, undefined);
  });

  test("any other failure becomes failed with a readable message, and a retry is possible", () => {
    const failed = reducePush({ status: "pushing" }, { type: "failure", status: 502, body: { reason: "push_failed", error: "the push was rejected" } });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, pushErrorMessage(502, { reason: "push_failed", error: "the push was rejected" }));
    assert.deepEqual(reducePush(failed, { type: "start" }), { status: "pushing" });
  });

  test("a failure after success cannot overwrite the pushed state", () => {
    const pushed = reducePush({ status: "pushing" }, OK);
    assert.deepEqual(reducePush(pushed, { type: "failure", status: 502, body: {} }), pushed);
  });

  test("reduce never mutates the previous state", () => {
    const before: PushState = { status: "pushing" };
    const snap = JSON.stringify(before);
    reducePush(before, OK);
    reducePush(before, { type: "failure", status: 500, body: {} });
    assert.equal(JSON.stringify(before), snap);
  });
});

describe("pushErrorMessage", () => {
  test("explains each failure in plain words, in terms of what the user can do", () => {
    assert.equal(pushErrorMessage(503, {}), "Push isn't set up. Add GIT_PUSH_TOKEN to .env and restart the control plane.");
    assert.equal(pushErrorMessage(409, { reason: "branch_exists" }), "A branch for this run already exists in the target repo.");
    assert.equal(pushErrorMessage(409, { reason: "stale_base" }), "The source repo changed, so the commit this run started from is no longer available.");
    assert.equal(pushErrorMessage(422, { reason: "patch_failed" }), "The patch no longer applies cleanly to the commit the run started from.");
    assert.equal(pushErrorMessage(422, { reason: "redacted_diff" }), "The diff contained a secret that was redacted, so it can't be pushed unchanged.");
    assert.equal(pushErrorMessage(502, { reason: "push_failed" }), "GitHub rejected the push. Check that the token has Contents read and write access to the target repo.");
    assert.equal(pushErrorMessage(0, {}), "Can't reach the control plane.");
  });

  test("falls back to the server's own message, then to the status code", () => {
    assert.equal(pushErrorMessage(409, { error: "only a successfully finished run can be pushed" }), "only a successfully finished run can be pushed");
    assert.equal(pushErrorMessage(400, { error: "the run has no diff or base commit to push" }), "the run has no diff or base commit to push");
    assert.equal(pushErrorMessage(500, {}), "Push failed (500).");
  });

  test("never echoes a token-shaped string from the server's message", () => {
    const m = pushErrorMessage(400, { error: "bad github_pat_11ABCDEFG_secretsecretsecret value" });
    assert.ok(m.includes("bad") && m.includes("value"), "the rest of the message is kept");
    assert.ok(!m.includes("github_pat_11ABCDEFG_secretsecretsecret"));
  });
});

describe("pushLabel and shortSha", () => {
  test("the button label follows the state", () => {
    assert.equal(pushLabel({ status: "idle" }), "Push to branch");
    assert.equal(pushLabel({ status: "pushing" }), "Pushing");
    assert.equal(pushLabel({ status: "pushed" }), "Pushed");
    assert.equal(pushLabel({ status: "failed" }), "Try push again");
  });

  test("shortSha shows the first seven characters of a 40-hex commit, and nothing for anything else", () => {
    assert.equal(shortSha("ea724cea11c755453e8d826872470b2448c1cca1"), "ea724ce");
    assert.equal(shortSha(undefined), "");
    assert.equal(shortSha(""), "");
    assert.equal(shortSha("short"), "");
    assert.equal(shortSha("z".repeat(40)), "");
  });
});
