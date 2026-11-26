// Per-run OpenRouter key client with a fake fetch: nothing here reaches the network. Run: node --test tests/unit/openrouter-keys.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRunKeys, parseRunKeyLimit } from "../../api/openrouter-keys.ts";
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
