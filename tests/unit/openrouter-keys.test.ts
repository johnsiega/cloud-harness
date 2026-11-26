// Per-run OpenRouter key client with a fake fetch: nothing here reaches the network. Run: node --test tests/unit/openrouter-keys.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRunKeys, parseRunKeyLimit } from "../../api/openrouter-keys.ts";
import { checkRunKeys, listRunKeys } from "../../scripts/check-run-keys.ts";
import type { RunKeys } from "../../api/openrouter-keys.ts";
import type { FetchLike } from "../../api/types.ts";

const MGMT = "sk-or-v1-MANAGEMENTKEY0123456789abcdefMGMT";
const RUN_KEY = "sk-or-v1-PERRUNKEY0123456789abcdefRUNKEY";
const NOW = 1_800_000_000_000;
const KEYS_URL = "https://openrouter.ai/api/v1/keys";
type Call = { url: string; init: any };

function fake(answer: (c: Call) => { status: number; body?: unknown } | Error, limitUsd = 0.1) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const c = { url, init };
    calls.push(c);
    const a = answer(c);
    if (a instanceof Error) throw a;
    return { ok: a.status < 300, status: a.status, json: async () => a.body, text: async () => JSON.stringify(a.body ?? "") };
  };
  return { calls, keys: createRunKeys({ managementKey: MGMT, limitUsd, fetch, now: () => NOW }) };
}
const CREATED = { status: 201, body: { data: { hash: "h1", name: "throwbox-run-r1" }, key: RUN_KEY } };
const noSecret = (msg: string) => {
  assert.ok(!msg.includes(MGMT), "an error must never contain the management key");
  assert.ok(!msg.includes("sk-or-"), "an error must never contain any key");
};

describe("create: the request", () => {
  test("POSTs name, limit and a 30-minute expiry to /api/v1/keys with the management key as a bearer token", async () => {
    const f = fake(() => CREATED, 0.25);
    await f.keys.create("throwbox-run-r1");
    assert.equal(f.calls.length, 1, "exactly one request");
    assert.ok(f.calls[0], "a request must be made"); // keeps the red run an assertion, not a TypeError
    assert.equal(f.calls[0].url, KEYS_URL);
    assert.equal(f.calls[0].init.method, "POST");
    assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${MGMT}`);
    assert.equal(f.calls[0].init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(f.calls[0].init.body), {
      name: "throwbox-run-r1", limit: 0.25, expires_at: new Date(NOW + 30 * 60_000).toISOString(),
    });
    assert.ok(f.calls[0].init.signal, "every request has a deadline");
  });
  test("expires_at includes seconds, as OpenRouter requires", async () => {
    const f = fake(() => CREATED);
    await f.keys.create("throwbox-run-r1");
    assert.ok(f.calls[0], "a request must be made");
    assert.match(JSON.parse(f.calls[0].init.body).expires_at, /T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });
  test("create(label, ttlMs) sets the expiry ttlMs from now", async () => {
    const f = fake(() => CREATED);
    await f.keys.create("throwbox-check-1", 60_000);
    assert.ok(f.calls[0], "a request must be made");
    assert.equal(JSON.parse(f.calls[0].init.body).expires_at, new Date(NOW + 60_000).toISOString());
  });
});

describe("create: the answer", () => {
  test("a 201 returns the top-level key and data.hash", async () => {
    assert.deepEqual(await fake(() => CREATED).keys.create("throwbox-run-r1"), { key: RUN_KEY, hash: "h1" });
  });
});

describe("create: failures have fixed text and never contain a key", () => {
  const cases: [string, () => { status: number; body?: unknown } | Error, string][] = [
    ["401", () => ({ status: 401, body: { error: { message: `bad key ${MGMT}` } } }), "could not create a per-run OpenRouter key (HTTP 401)"],
    ["403", () => ({ status: 403 }), "could not create a per-run OpenRouter key (HTTP 403)"],
    ["429", () => ({ status: 429 }), "could not create a per-run OpenRouter key (HTTP 429)"],
    ["500 echoing a key", () => ({ status: 500, body: { error: RUN_KEY } }), "could not create a per-run OpenRouter key (HTTP 500)"],
    ["201 without key", () => ({ status: 201, body: { data: { hash: "h1" } } }), "could not create a per-run OpenRouter key (unexpected answer)"],
    ["201 with a non sk-or- key", () => ({ status: 201, body: { data: { hash: "h1" }, key: "abc" } }), "could not create a per-run OpenRouter key (unexpected answer)"],
    ["201 without data.hash", () => ({ status: 201, body: { key: RUN_KEY } }), "could not create a per-run OpenRouter key (unexpected answer)"],
    ["200 instead of 201", () => ({ status: 200, body: CREATED.body }), "could not create a per-run OpenRouter key (HTTP 200)"],
    ["network error", () => new Error(`ECONNRESET ${MGMT}`), "could not create a per-run OpenRouter key (OpenRouter unreachable)"],
    ["timeout", () => new DOMException("The operation was aborted due to timeout", "TimeoutError"), "could not create a per-run OpenRouter key (OpenRouter unreachable)"],
  ];
  for (const [name, answer, message] of cases) {
    test(name, async () => {
      await assert.rejects(fake(answer).keys.create("throwbox-run-r1"), (e: Error) => {
        assert.equal(e.message, message);
        noSecret(e.message);
        return true;
      });
    });
  }
});

describe("delete", () => {
  test("DELETEs /api/v1/keys/<hash> with the management key and a deadline; 200 resolves", async () => {
    const f = fake(() => ({ status: 200, body: { deleted: true } }));
    await f.keys.delete("h1");
    assert.equal(f.calls.length, 1, "exactly one request");
    assert.ok(f.calls[0], "a request must be made");
    assert.equal(f.calls[0].url, `${KEYS_URL}/h1`);
    assert.equal(f.calls[0].init.method, "DELETE");
    assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${MGMT}`);
    assert.ok(f.calls[0].init.signal, "every request has a deadline");
  });
  test("404 resolves: the key is already gone, which is the goal", async () => {
    const f = fake(() => ({ status: 404 }));
    await f.keys.delete("h1");
    assert.equal(f.calls.length, 1, "a request must be made");
  });
  test("500 and a network error reject with fixed text that contains no key", async () => {
    await assert.rejects(fake(() => ({ status: 500, body: { error: MGMT } })).keys.delete("h1"), (e: Error) => {
      assert.equal(e.message, "could not delete the per-run OpenRouter key (HTTP 500)");
      noSecret(e.message);
      return true;
    });
    await assert.rejects(fake(() => new Error(`down ${MGMT}`)).keys.delete("h1"), (e: Error) => {
      assert.equal(e.message, "could not delete the per-run OpenRouter key (OpenRouter unreachable)");
      noSecret(e.message);
      return true;
    });
  });
  test("an invalid hash is refused before any request (no path injection)", async () => {
    for (const hash of ["", "../keys", "a/b", "h1?x=1", "h 1", "x".repeat(129)]) {
      const f = fake(() => ({ status: 200 }));
      await assert.rejects(f.keys.delete(hash), /invalid key hash/, `hash ${JSON.stringify(hash)}`);
      assert.equal(f.calls.length, 0, `no request for ${JSON.stringify(hash)}`);
    }
  });
});

describe("parseRunKeyLimit", () => {
  test("unset or empty gives the 0.10 default; a positive number below 1,000,000 is kept", () => {
    assert.equal(parseRunKeyLimit(undefined), 0.1);
    assert.equal(parseRunKeyLimit(""), 0.1);
    assert.equal(parseRunKeyLimit("0.25"), 0.25);
    assert.equal(parseRunKeyLimit("999999"), 999999);
  });
  test("anything else throws the fixed message", () => {
    for (const raw of ["0", "-1", "abc", "1e6", "1000000", "Infinity", "NaN", " ", "0x10"]) {
      assert.throws(() => parseRunKeyLimit(raw), { message: "RUN_KEY_LIMIT_USD must be a positive number of US dollars below 1000000" }, `value ${JSON.stringify(raw)}`);
    }
  });
});

// ---- scripts/check-run-keys.ts ----
const KEY_URL = "https://openrouter.ai/api/v1/key";

function checkRig(o: { deletedStatus?: number; expiredStatus?: number; liveStatus?: number; fetchThrows?: boolean; deleteThrows?: boolean } = {}) {
  const calls = { create: [] as [string, number | undefined][], delete: [] as string[], sleep: [] as number[], gets: [] as string[] };
  const dead = new Set<string>();
  let expired = false;
  let n = 0;
  const keys: RunKeys = {
    create: async (label, ttlMs) => { calls.create.push([label, ttlMs]); n++; return { key: `sk-or-v1-CHECKKEY${n}`, hash: `h${n}` }; },
    delete: async (hash) => { calls.delete.push(hash); if (o.deleteThrows) throw new Error("could not delete the per-run OpenRouter key (HTTP 500)"); dead.add(`sk-or-v1-CHECKKEY${hash.slice(1)}`); },
  };
  const fetch: FetchLike = async (url, init) => {
    assert.equal(url, KEY_URL, "only the free key-info endpoint is called");
    const key = init!.headers!.Authorization.replace("Bearer ", "");
    calls.gets.push(key);
    if (o.fetchThrows) throw new Error(`ECONNRESET ${key}`);
    const status = dead.has(key) ? (o.deletedStatus ?? 401) : expired && key.endsWith("2") ? (o.expiredStatus ?? 401) : (o.liveStatus ?? 200);
    return { ok: status < 300, status, json: async () => ({}), text: async () => "" };
  };
  const lines: string[] = [];
  const sleep = async (ms: number) => { calls.sleep.push(ms); expired = true; };
  const run = () => checkRunKeys({ keys, fetch, sleep, log: (s) => lines.push(s) });
  return { run, calls, lines, text: () => lines.join("\n") };
}

describe("checkRunKeys", () => {
  test("refused deleted and expired keys give exit 0, 'yes' twice, a 60 s key and a 75 s wait", async () => {
    const r = checkRig();
    assert.equal(await r.run(), 0);
    assert.equal(r.calls.create.length, 2);
    assert.match(r.calls.create[0][0], /^throwbox-check-/);
    assert.equal(r.calls.create[0][1], undefined, "the first key has the normal expiry");
    assert.equal(r.calls.create[1][1], 60_000);
    assert.deepEqual(r.calls.sleep, [75_000]);
    assert.deepEqual(r.calls.delete, ["h1", "h2"]);
    assert.equal(r.calls.gets.length, 4);
    assert.match(r.text(), /deleted key refused: yes/);
    assert.match(r.text(), /expired key refused: yes/);
  });
  test("a deleted key that still answers 200 gives exit 1 and 'no'", async () => {
    const r = checkRig({ deletedStatus: 200 });
    assert.equal(await r.run(), 1);
    assert.match(r.text(), /deleted key refused: no \(HTTP 200\)/);
  });
  test("an expired key that still answers 200 gives exit 1 and 'no'", async () => {
    const r = checkRig({ expiredStatus: 200 });
    assert.equal(await r.run(), 1);
    assert.match(r.text(), /expired key refused: no \(HTTP 200\)/);
  });
  test("a fresh key that is not accepted gives exit 1 and still deletes it", async () => {
    const r = checkRig({ liveStatus: 500 });
    assert.equal(await r.run(), 1);
    assert.ok(r.calls.delete.includes("h1"), "the created key is deleted");
  });
  test("a request error gives exit 1, deletes every created key and never prints a key", async () => {
    const r = checkRig({ fetchThrows: true });
    assert.equal(await r.run(), 1);
    assert.equal(r.calls.delete.length, r.calls.create.length);
    assert.ok(r.calls.create.length > 0, "a key must have been created");
    assert.ok(!r.text().includes("sk-or-"), "no key in the output");
  });
  test("a delete that fails gives exit 1 and says so", async () => {
    const r = checkRig({ deleteThrows: true });
    assert.equal(await r.run(), 1);
    assert.match(r.text(), /could not delete/);
  });
  test("the output never contains a key", async () => {
    const r = checkRig();
    await r.run();
    assert.ok(r.lines.length > 0, "something must be printed");
    assert.ok(!r.text().includes("sk-or-"));
  });
});

describe("listRunKeys", () => {
  test("lists only throwbox-run- keys with name and expires_at, across pages, including disabled and expired", async () => {
    const urls: string[] = [];
    const pages = [
      [{ name: "throwbox-run-a", expires_at: "2026-11-26T10:00:00Z", label: "sk-or-v1-abc...xyz" }, { name: "my-own-key", expires_at: null }],
      [{ name: "throwbox-run-b", expires_at: null }],
      [],
    ];
    const fetch: FetchLike = async (url, init) => {
      urls.push(url);
      assert.equal(init!.headers!.Authorization, `Bearer ${MGMT}`);
      return { ok: true, status: 200, json: async () => ({ data: pages[urls.length - 1] ?? [] }), text: async () => "" };
    };
    const lines: string[] = [];
    assert.equal(await listRunKeys({ managementKey: MGMT, fetch, log: (s) => lines.push(s) }), 0);
    const out = lines.join("\n");
    assert.match(out, /throwbox-run-a.*2026-11-26T10:00:00Z/);
    assert.match(out, /throwbox-run-b/);
    assert.ok(!out.includes("my-own-key"));
    assert.ok(!out.includes("sk-or-"), "no key or label is printed");
    assert.ok(urls[0].includes("include_disabled=true") && urls[0].includes("include_expired=true"));
    assert.ok(urls[1].includes("offset=2"), "the next page starts after the rows already read");
  });
  test("an error answer gives exit 1 with the status only", async () => {
    const lines: string[] = [];
    const fetch: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => MGMT });
    assert.equal(await listRunKeys({ managementKey: MGMT, fetch, log: (s) => lines.push(s) }), 1);
    assert.match(lines.join("\n"), /HTTP 401/);
    assert.ok(!lines.join("\n").includes(MGMT));
  });
});
