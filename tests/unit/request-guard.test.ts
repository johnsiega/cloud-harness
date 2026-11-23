// Cross-site request and DNS-rebinding protection for the loopback API. Run: node --test tests/unit/request-guard.test.ts
// Binding to 127.0.0.1 does not stop a web page in the user's browser from calling this API, so every request is checked.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { checkRequest } from "../../api/request-guard.ts";
import { createApp, startServer } from "../../api/server.ts";
import { createRunStore } from "../../api/run-store.ts";
import { createRedactor } from "../../api/redact.ts";

const JSON_TYPE = "application/json";
const HOST = "127.0.0.1:3000";
const GOOD = { repoUrl: "https://github.com/jyvnn/hospital-queue", task: "add a comment above enabled()" };
const post = (o: { host?: string; origin?: string; contentType?: string }) => checkRequest({ method: "POST", host: HOST, contentType: JSON_TYPE, ...o });
const statusOf = (r: ReturnType<typeof checkRequest>) => (r.ok ? "ok" : r.status);

function setup() {
  let n = 0;
  const store = createRunStore({ now: () => 1000, ttlMs: 1e9, newId: () => `run-${++n}` });
  const started: string[] = [];
  const app = createApp({ store, redact: createRedactor([]), startRun: (id) => { started.push(id); } });
  return { app, store, started };
}

// fetch() cannot set Host, so the rebinding tests use a raw HTTP request against a real listening server.
function raw(port: number, o: { method?: string; path: string; headers: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: o.method ?? "GET", path: o.path, headers: o.headers, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

describe("checkRequest: Host", () => {
  test("accepts loopback hosts, with or without a port, in any case", () => {
    for (const host of ["127.0.0.1:3000", "127.0.0.1", "localhost:5173", "localhost", "LOCALHOST:3000"]) {
      assert.deepEqual(checkRequest({ method: "GET", host }), { ok: true }, host);
    }
  });

  test("rejects every other Host with 403, which is what stops DNS rebinding", () => {
    const bad = [
      "evil.example", "evil.example:3000", "127.0.0.1.evil.example", "localhost.evil.example",
      "127.0.0.1@evil.example", "evil.example#127.0.0.1", "0.0.0.0:3000", "[::1]:3000", "127.0.0.2:3000",
      "localhost:abc", "localhost:", "127.0.0.1:3000,evil.example", "", undefined,
    ];
    for (const host of bad) assert.equal(statusOf(checkRequest({ method: "GET", host })), 403, String(host));
  });
});

describe("checkRequest: Origin", () => {
  test("accepts an Origin that exactly matches the Host, including through the Vite dev proxy", () => {
    assert.deepEqual(post({ origin: "http://127.0.0.1:3000" }), { ok: true });
    assert.deepEqual(post({ host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" }), { ok: true });
    assert.deepEqual(post({ host: "localhost:3000", origin: "http://localhost:3000" }), { ok: true });
  });

  test("accepts a request with no Origin, as sent by curl and other non-browser clients", () => {
    assert.deepEqual(post({}), { ok: true });
  });

  test("rejects foreign, opaque, wrong-scheme and wrong-port origins with 403", () => {
    const bad = [
      "https://evil.example", "http://evil.example:3000", "null", "", "https://127.0.0.1:3000",
      "http://127.0.0.1:9999", "http://localhost:3000", "http://127.0.0.1:3000.evil.example", "http://127.0.0.1:3000/path",
    ];
    for (const origin of bad) assert.equal(statusOf(post({ origin })), 403, JSON.stringify(origin));
  });

  test("a foreign Origin is rejected on GET and OPTIONS too, not just POST", () => {
    for (const method of ["GET", "OPTIONS", "HEAD"]) {
      assert.equal(statusOf(checkRequest({ method, host: HOST, origin: "https://evil.example" })), 403, method);
    }
  });
});

describe("checkRequest: Content-Type", () => {
  test("POST accepts application/json, with parameters and in any case", () => {
    for (const contentType of ["application/json", "application/json; charset=utf-8", "Application/JSON", "application/json;charset=UTF-8"]) {
      assert.deepEqual(post({ contentType }), { ok: true }, contentType);
    }
  });

  test("POST rejects everything a browser can send without a CORS preflight, plus lookalikes, with 415", () => {
    const bad = ["text/plain", "text/plain; application/json", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx", "application/json-patch+json", "", undefined];
    for (const contentType of bad) assert.equal(statusOf(post({ contentType })), 415, String(contentType));
  });

  test("GET needs no Content-Type", () => {
    assert.deepEqual(checkRequest({ method: "GET", host: HOST }), { ok: true });
  });

  test("a foreign Origin with a bad Content-Type reports 403, the security failure first", () => {
    assert.equal(statusOf(post({ origin: "https://evil.example", contentType: "text/plain" })), 403);
  });

  test("a rejection carries a non-empty error message", () => {
    const r = post({ contentType: "text/plain" });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.length > 0);
  });
});

describe("API routes behind the guard", () => {
  test("regression: a cross-origin text/plain POST /runs gets 403 and starts no MicroVM", async () => {
    const s = setup();
    const res = await s.app.request("/runs", { method: "POST", headers: { "content-type": "text/plain", origin: "https://evil.example" }, body: JSON.stringify(GOOD) });
    assert.equal(res.status, 403);
    assert.deepEqual(s.started, []);
    assert.equal(s.store.get("run-1"), undefined);
  });

  test("a same-origin POST with the wrong Content-Type gets 415 and starts nothing", async () => {
    const s = setup();
    const res = await s.app.request("/runs", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(GOOD) });
    assert.equal(res.status, 415);
    assert.equal(typeof (await res.json()).error, "string");
    assert.deepEqual(s.started, []);
  });

  test("a valid same-origin JSON POST still answers 202 and starts the run", async () => {
    const s = setup();
    const res = await s.app.request("http://127.0.0.1:3000/runs", { method: "POST", headers: { "content-type": JSON_TYPE, origin: "http://127.0.0.1:3000" }, body: JSON.stringify(GOOD) });
    assert.equal(res.status, 202);
    assert.deepEqual(s.started, ["run-1"]);
  });

  test("a foreign Origin cannot read a run record or its stream", async () => {
    const s = setup();
    s.store.create(GOOD);
    s.store.append("run-1", { type: "stdout", ts: 1, text: "private-marker" });
    s.store.append("run-1", { type: "done", ts: 2, exitCode: 0 });
    for (const path of ["/runs/run-1", "/runs/run-1/stream"]) {
      const res = await s.app.request(path, { headers: { origin: "https://evil.example" } });
      assert.equal(res.status, 403, path);
      assert.ok(!(await res.text()).includes("private-marker"), path);
    }
  });

  test("responses never grant cross-origin access", async () => {
    const s = setup();
    const res = await s.app.request("/health");
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
});

describe("real socket: DNS rebinding", () => {
  test("a request whose Host is an attacker's domain gets 403, and the loopback Host still works", async () => {
    const s = setup();
    const srv = await startServer(s.app, { port: 0 });
    try {
      assert.equal((await raw(srv.port, { path: "/health", headers: { host: `evil.example:${srv.port}` } })).status, 403);
      assert.equal((await raw(srv.port, { path: "/health", headers: { host: `127.0.0.1:${srv.port}` } })).status, 200);
    } finally {
      await srv.close();
    }
  });

  test("a rebinding POST with a same-host Origin and JSON body still cannot start a run", async () => {
    const s = setup();
    const srv = await startServer(s.app, { port: 0 });
    try {
      const host = `evil.example:${srv.port}`;
      const res = await raw(srv.port, { method: "POST", path: "/runs", headers: { host, origin: `http://${host}`, "content-type": JSON_TYPE }, body: JSON.stringify(GOOD) });
      assert.equal(res.status, 403);
      assert.deepEqual(s.started, []);
    } finally {
      await srv.close();
    }
  });
});
