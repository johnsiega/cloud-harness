// scripts/kill-all.ts with a fake AWS layer: it cannot terminate anything real. Run: node --test tests/unit/kill-all.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { exitCodeFor, formatReport, killAll, parseArgs, planKill } from "../../scripts/kill-all.ts";
import type { KillResult, Vm } from "../../scripts/kill-all.ts";

const IMAGE = "arn:aws:lambda:us-east-1:111122223333:microvm-image:hq";
const VMS: Vm[] = [
  { microvmId: "vm-run", state: "RUNNING" },
  { microvmId: "vm-gone", state: "TERMINATED" },
  { microvmId: "vm-susp", state: "SUSPENDED" },
  { microvmId: "vm-term", state: "TERMINATING" },
  { microvmId: "vm-pend", state: "PENDING" },
];

type Fail = (id: string, attempt: number) => Error | undefined;
function setup(o: { vms?: Vm[]; fail?: Fail } = {}) {
  const calls = { list: [] as (string | undefined)[], terminate: [] as string[], sleeps: [] as number[] };
  const attempts = new Map<string, number>();
  const aws = {
    list: async (image?: string) => { calls.list.push(image); return o.vms ?? VMS; },
    terminate: async (id: string) => {
      calls.terminate.push(id);
      const n = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, n);
      const err = o.fail?.(id, n);
      if (err) throw err;
    },
  };
  return { deps: { aws, sleep: async (ms: number) => { calls.sleeps.push(ms); } }, calls };
}
const named = (name: string, message = name) => Object.assign(new Error(message), { name });

describe("planKill", () => {
  test("keeps every VM that is not already gone, and drops TERMINATED and TERMINATING", () => {
    assert.deepEqual(planKill(VMS).map((v) => v.microvmId), ["vm-run", "vm-susp", "vm-pend"]);
  });

  test("the state check ignores case, and an empty list gives an empty plan", () => {
    assert.deepEqual(planKill([{ microvmId: "x", state: "terminated" }, { microvmId: "y", state: "Running" }]).map((v) => v.microvmId), ["y"]);
    assert.deepEqual(planKill([]), []);
  });
});

describe("killAll: dry run (the default)", () => {
  test("lists what it would terminate and terminates nothing", async () => {
    const s = setup();
    const r = await killAll(s.deps, { yes: false });
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.planned.map((v) => v.microvmId), ["vm-run", "vm-susp", "vm-pend"]);
    assert.deepEqual(r.terminated, []);
    assert.deepEqual(s.calls.terminate, []);
    assert.equal(s.calls.list.length, 1);
  });

  test("an image filter is passed to the listing", async () => {
    const s = setup();
    await killAll(s.deps, { yes: false, imageArn: IMAGE });
    assert.deepEqual(s.calls.list, [IMAGE]);
  });
});

describe("killAll --yes", () => {
  test("terminates exactly the planned VMs, in order, and reports them", async () => {
    const s = setup();
    const r = await killAll(s.deps, { yes: true });
    assert.equal(r.dryRun, false);
    assert.deepEqual(s.calls.terminate, ["vm-run", "vm-susp", "vm-pend"]);
    assert.deepEqual(r.terminated, ["vm-run", "vm-susp", "vm-pend"]);
    assert.deepEqual(r.failed, []);
  });

  test("paces terminations: one pause between VMs (default 200 ms), none before the first or after the last", async () => {
    const s = setup();
    await killAll(s.deps, { yes: true });
    assert.deepEqual(s.calls.sleeps, [200, 200]);
    const s2 = setup();
    await killAll(s2.deps, { yes: true, paceMs: 350 });
    assert.deepEqual(s2.calls.sleeps, [350, 350]);
  });

  test("a failure on one VM does not stop the others, and is reported with its message", async () => {
    const s = setup({ fail: (id) => (id === "vm-susp" ? new Error("boom") : undefined) });
    const r = await killAll(s.deps, { yes: true });
    assert.deepEqual(s.calls.terminate, ["vm-run", "vm-susp", "vm-pend"]);
    assert.deepEqual(r.terminated, ["vm-run", "vm-pend"]);
    assert.deepEqual(r.failed, [{ microvmId: "vm-susp", error: "boom" }]);
  });

  test("ThrottlingException is retried with doubling backoff (500, 1000 ms) and then succeeds", async () => {
    const s = setup({ vms: [{ microvmId: "vm-1", state: "RUNNING" }], fail: (_id, n) => (n <= 2 ? named("ThrottlingException", "Rate exceeded") : undefined) });
    const r = await killAll(s.deps, { yes: true });
    assert.deepEqual(s.calls.terminate, ["vm-1", "vm-1", "vm-1"]);
    assert.deepEqual(s.calls.sleeps, [500, 1000]);
    assert.deepEqual(r.terminated, ["vm-1"]);
  });

  test("it gives up after maxAttempts throttled tries (default 5) and reports the VM as failed", async () => {
    const s = setup({ vms: [{ microvmId: "vm-1", state: "RUNNING" }], fail: () => named("ThrottlingException", "Rate exceeded") });
    const r = await killAll(s.deps, { yes: true });
    assert.equal(s.calls.terminate.length, 5);
    assert.deepEqual(r.terminated, []);
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0].error, /Rate exceeded/);
  });

  test("an error that is not throttling is not retried", async () => {
    const s = setup({ vms: [{ microvmId: "vm-1", state: "RUNNING" }], fail: () => named("AccessDeniedException", "not allowed") });
    const r = await killAll(s.deps, { yes: true });
    assert.equal(s.calls.terminate.length, 1);
    assert.deepEqual(r.failed, [{ microvmId: "vm-1", error: "not allowed" }]);
  });

  test("a VM that vanished between the listing and the terminate (ResourceNotFoundException) counts as terminated", async () => {
    const s = setup({ vms: [{ microvmId: "vm-1", state: "RUNNING" }], fail: () => named("ResourceNotFoundException", "gone") });
    const r = await killAll(s.deps, { yes: true });
    assert.deepEqual(r.terminated, ["vm-1"]);
    assert.deepEqual(r.failed, []);
  });

  test("nothing to terminate: no terminate calls, no pauses, empty result", async () => {
    const s = setup({ vms: [{ microvmId: "x", state: "TERMINATED" }] });
    const r = await killAll(s.deps, { yes: true });
    assert.equal(s.calls.list.length, 1, "it must still have looked");
    assert.deepEqual(r, { dryRun: false, planned: [], terminated: [], failed: [] });
    assert.deepEqual(s.calls.terminate, []);
    assert.deepEqual(s.calls.sleeps, []);
  });
});

describe("exitCodeFor", () => {
  const base: KillResult = { dryRun: false, planned: [], terminated: [], failed: [] };
  test("0 when nothing failed, 1 when any VM failed", () => {
    assert.equal(exitCodeFor(base), 0);
    assert.equal(exitCodeFor({ ...base, terminated: ["a"] }), 0);
    assert.equal(exitCodeFor({ ...base, terminated: ["a"], failed: [{ microvmId: "b", error: "x" }] }), 1);
  });
  test("a dry run that found VMs is exit 0", () => {
    assert.equal(exitCodeFor({ ...base, dryRun: true, planned: [{ microvmId: "a", state: "RUNNING" }] }), 0);
    assert.equal(exitCodeFor({ ...base, failed: [{ microvmId: "b", error: "x" }] }), 1, "control: a real run with a failure is 1");
  });
});

describe("formatReport", () => {
  test("a dry run lists each VM with its state and the exact command to run with --yes", () => {
    const text = formatReport({ dryRun: true, planned: [{ microvmId: "vm-a", state: "RUNNING" }, { microvmId: "vm-b", state: "SUSPENDED" }], terminated: [], failed: [] }, {});
    assert.match(text, /vm-a\s+RUNNING/);
    assert.match(text, /vm-b\s+SUSPENDED/);
    assert.match(text, /dry run/i);
    assert.match(text, /node scripts\/kill-all\.ts --yes/);
  });

  test("the command repeats the image filter when one was used", () => {
    const text = formatReport({ dryRun: true, planned: [{ microvmId: "vm-a", state: "RUNNING" }], terminated: [], failed: [] }, { imageArn: IMAGE });
    assert.ok(text.includes(`--yes --image ${IMAGE}`) || text.includes(`--image ${IMAGE} --yes`), text);
  });

  test("a dry run with nothing to kill says so and prints no command", () => {
    const text = formatReport({ dryRun: true, planned: [], terminated: [], failed: [] }, {});
    assert.match(text, /no MicroVMs to terminate/i);
    assert.doesNotMatch(text, /--yes/);
  });

  test("a real run summarises the counts and names every failure", () => {
    const text = formatReport({ dryRun: false, planned: [], terminated: ["vm-a", "vm-b"], failed: [{ microvmId: "vm-c", error: "boom" }] }, {});
    assert.match(text, /terminated 2/i);
    assert.match(text, /failed 1/i);
    assert.match(text, /vm-c.*boom/);
  });
});

describe("parseArgs", () => {
  test("no arguments is a dry run", () => {
    assert.deepEqual(parseArgs([]), { yes: false });
  });
  test("--yes turns the dry run off, --image <arn> filters", () => {
    assert.deepEqual(parseArgs(["--yes"]), { yes: true });
    assert.deepEqual(parseArgs(["--yes", "--image", IMAGE]), { yes: true, imageArn: IMAGE });
  });
  test("an unknown flag or a missing --image value is an error, so a typo never triggers a real run", () => {
    assert.throws(() => parseArgs(["--yess"]), /unknown|usage/i);
    assert.throws(() => parseArgs(["--image"]), /--image/);
    assert.throws(() => parseArgs(["-y"]), /unknown|usage/i);
  });
});
