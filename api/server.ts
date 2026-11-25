// Hono control plane: POST /runs, GET /runs/:id, GET /runs/:id/stream (SSE). Binds to 127.0.0.1 only.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { buildRunRequest } from "../scripts/smoke-test.ts";
import type { PushInput, PushResult } from "./patch-delivery.ts";
import { checkRequest } from "./request-guard.ts";
import { registerSimulation } from "./simulate-routes.ts";
import type { SimDeps } from "./simulate-routes.ts";
import { formatSse } from "./sse.ts";
import type { Redactor, RunRecord, RunRequest, RunStore } from "./types.ts";

export interface AppDeps {
  store: RunStore;
  startRun: (id: string) => void;
  redact: Redactor;
  /** Present only when a push token and target are configured; otherwise the push route answers 503. */
  /** Test seam for the simulation routes; defaults to real timers. */
  sim?: SimDeps;
  push?: { token: string; targetUrl: string; deliver: (input: PushInput) => Promise<PushResult> };
}

const PUSH_STATUS = { invalid_input: 400, redacted_diff: 422, branch_exists: 409, stale_base: 409, patch_failed: 422, push_failed: 502 } as const;

type Validated = { ok: true; req: RunRequest } | { ok: false; error: string };

function validate(body: unknown): Validated {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (typeof b.repoUrl !== "string") return { ok: false, error: "repoUrl is required" };
  if (typeof b.task !== "string" || !b.task.trim()) return { ok: false, error: "task is required" };
  if (b.model !== undefined && typeof b.model !== "string") return { ok: false, error: "model must be a string" };
  const req: RunRequest = { repoUrl: b.repoUrl, task: b.task, ...(b.model !== undefined ? { model: b.model as string } : {}) };
  try {
    // Dry run of the real request builder: checks the GitHub-only URL, model id format and the 16 KB payload limit.
    buildRunRequest({ imageArn: "arn:validation-only", repoUrl: req.repoUrl, task: req.task, apiKey: "x".repeat(100), model: req.model });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "invalid request" };
  }
  return { ok: true, req };
}

export function createApp(d: AppDeps): Hono {
  const app = new Hono();
  const scrub = (r: RunRecord): RunRecord => ({ ...r, events: r.events.map((e) => d.redact.event(e)), ...(r.diff !== undefined ? { diff: d.redact.text(r.diff) } : {}) });

  app.use("*", async (c, next) => {
    const g = checkRequest({
      method: c.req.method,
      host: c.req.header("host") ?? new URL(c.req.url).host,
      origin: c.req.header("origin"),
      contentType: c.req.header("content-type"),
    });
    if (!g.ok) return c.json({ error: g.error }, g.status);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  registerSimulation(app, d.sim);

  app.post("/runs", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    const v = validate(body);
    if (!v.ok) return c.json({ error: v.error }, 400);
    const created = d.store.create(v.req);
    if (!created.ok) return c.json({ error: "duplicate run in progress", existingId: created.existingId }, 409);
    try { d.startRun(created.record.id); } catch { /* the run reports its own failure; the request still succeeded */ }
    return c.json({ id: created.record.id }, 202);
  });

  // Tells the UI whether to show the push button. Never includes the token or the full URL.
  app.get("/config", (c) => {
    if (!d.push) return c.json({ pushEnabled: false });
    return c.json({ pushEnabled: true, pushTarget: new URL(d.push.targetUrl).pathname.replace(/^\/|\.git$/g, "") });
  });

  // Push the finished run's diff to harness/<runId> in the configured private repo. The caller chooses nothing: the branch,
  // target, base commit and diff all come from the stored run and the server's own config, and a run can be pushed once.
  const pushing = new Set<string>();
  app.post("/runs/:id/push", async (c) => {
    const id = c.req.param("id");
    const run = d.store.get(id);
    if (!run) return c.json({ error: "run not found" }, 404);
    if (!d.push) return c.json({ error: "push is not configured: set GIT_PUSH_TOKEN in .env (optionally PUSH_TARGET_URL) and restart" }, 503);
    if (run.push) return c.json({ error: "this run was already pushed", branch: run.push.branch, url: run.push.url }, 409);
    if (pushing.has(id)) return c.json({ error: "a push for this run is already in progress" }, 409);
    if (run.status !== "done") return c.json({ error: "only a successfully finished run can be pushed" }, 409);
    if (!run.diff || run.diff.trim() === "" || !run.baseCommit) return c.json({ error: "the run has no diff or base commit to push" }, 400);

    pushing.add(id);
    let result: PushResult;
    try {
      result = await d.push.deliver({ sourceUrl: run.request.repoUrl, targetUrl: d.push.targetUrl, baseCommit: run.baseCommit, diff: run.diff, runId: id, token: d.push.token });
    } catch (e) {
      result = { ok: false, reason: "push_failed", error: e instanceof Error ? e.message : String(e), log: "" };
    } finally {
      pushing.delete(id);
    }

    if (!result.ok) {
      return c.json({ error: d.redact.text(result.error), reason: result.reason, log: d.redact.text(result.log) }, PUSH_STATUS[result.reason] ?? 502);
    }
    const url = `${d.push.targetUrl.replace(/\.git$/, "")}/tree/${result.branch}`;
    d.store.update(id, { push: { branch: result.branch, commit: result.commit, url } });
    return c.json({ branch: result.branch, commit: result.commit, url });
  });

  app.get("/runs/:id", (c) => {
    const r = d.store.get(c.req.param("id"));
    return r ? c.json(scrub(r)) : c.json({ error: "run not found" }, 404);
  });

  app.get("/runs/:id/stream", (c) => {
    const id = c.req.param("id");
    if (!d.store.get(id)) return c.json({ error: "run not found" }, 404);
    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        let chain: Promise<unknown> = Promise.resolve();
        let off = () => {};
        let closed = false;
        const close = () => { if (!closed) { closed = true; off(); resolve(); } };
        stream.onAbort(close);
        try {
          // subscribe() replays history first, so events appended before this point are never missed.
          off = d.store.subscribe(id, (e) => {
            if (closed) return;
            const frame = formatSse(d.redact.event(e), id);
            chain = chain.then(() => stream.write(frame));
            if (e.type === "done") chain = chain.then(close);
          });
        } catch { close(); }
      });
    });
  });

  return app;
}

export async function startServer(
  app: { fetch: (req: Request) => Response | Promise<Response> },
  o: { port?: number } = {},
): Promise<{ address: string; port: number; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: o.port ?? 3000, hostname: "127.0.0.1" }, (info) =>
      resolve({
        address: info.address,
        port: info.port,
        close: () => new Promise<void>((r) => { (server as any).closeAllConnections?.(); server.close(() => r()); }),
      }),
    );
  });
}
