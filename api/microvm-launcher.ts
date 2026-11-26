// Launches one MicroVM and talks to its in-VM runner. AWS and fetch are injected so this is unit-testable.
// With runKeys, each run gets its own capped key, deleted when its MicroVM is terminated.
// The OpenRouter key travels ONLY in the run hook payload (never env, never URL/header/body of runner calls).
import { buildRunRequest, buildRunnerPost } from "../scripts/smoke-test.ts";
import type { AwsMicrovms, FetchLike, MicroVMLauncher, PollResult, SandboxHandle } from "./types.ts";
import type { RunKeys } from "./openrouter-keys.ts";

export function createMicrovmLauncher(o: {
  aws: AwsMicrovms;
  imageArn: string;
  apiKey: string;
  region?: string;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
  readyPollMs?: number;
  /** Per-request limit for every call to the in-VM runner (health, start, poll). Default 30 s. */
  requestTimeoutMs?: number;
  /** Optional: a fresh OpenRouter key per run. apiKey is then never sent to a VM. */
  runKeys?: RunKeys;
  warn?: (message: string) => void;
}): MicroVMLauncher {
  const doFetch: FetchLike = o.fetch ?? ((url, init) => fetch(url, init));
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const readyTimeoutMs = o.readyTimeoutMs ?? 5 * 60_000;
  const readyPollMs = o.readyPollMs ?? 250;
  const requestTimeoutMs = o.requestTimeoutMs ?? 30_000;
  // Every runner call gets a deadline: a VM killed mid-run leaves a bare fetch() hanging, which would strand the run.
  const call: FetchLike = async (url, init) => {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new Error(`request to the sandbox timed out after ${requestTimeoutMs} ms`);
      throw e;
    }
  };
  const auth = (h: Pick<SandboxHandle, "authToken">) => ({ "X-aws-proxy-auth": h.authToken, "X-aws-proxy-port": "8080" });

  const warn = o.warn ?? ((message: string) => console.warn(message));
  // Same shape and length as a real key, so a bad request is rejected before a key is created.
  const PLACEHOLDER = "sk-or-v1-" + "0".repeat(64);

  const dropKey = async (hash: string | undefined) => {
    if (!hash) return;
    try { await o.runKeys?.delete(hash); } catch { warn("warning: could not delete the per-run OpenRouter key; it expires on its own"); }
  };

  const terminate = async (h: Pick<SandboxHandle, "microvmId" | "keyHash">) => {
    try { await o.aws.terminate(h.microvmId); } catch { /* best effort: cleanup must never mask the real error */ }
    await dropKey(h.keyHash);
  };

  return {
    async launch(req, runId) {
      const build = (apiKey: string) => buildRunRequest({ imageArn: o.imageArn, repoUrl: req.repoUrl, task: req.task, apiKey, region: o.region, model: req.model });
      // Validates the repo URL, model id and payload size before anything is created, in OpenRouter or AWS.
      let input = build(o.runKeys ? PLACEHOLDER : o.apiKey);
      const submitMs = now();
      const runKey = await o.runKeys?.create(`throwbox-run-${runId ?? submitMs}`); // a failure ends the run: never fall back to apiKey
      const keyHash = runKey?.hash;
      let started: { microvmId: string; endpoint: string };
      try {
        if (runKey) input = build(runKey.key);
        started = await o.aws.run(input);
      } catch (e) {
        await dropKey(keyHash); // e.g. a quota refusal: no VM exists, so nothing else would delete it
        throw e;
      }
      const { microvmId, endpoint } = started;
      try {
        const authToken = await o.aws.authToken(microvmId);
        for (;;) {
          try {
            const r = await call(`https://${endpoint}/health`, { headers: auth({ authToken }) });
            if (r.ok) return { microvmId, endpoint, authToken, submitMs, readyMs: now(), ...(keyHash ? { keyHash } : {}) };
          } catch { /* endpoint not routable yet */ }
          if (now() - submitMs >= readyTimeoutMs) throw new Error(`sandbox not ready after ${readyTimeoutMs} ms`);
          await sleep(readyPollMs);
        }
      } catch (e) {
        await terminate({ microvmId, keyHash }); // don't leak a half-started MicroVM or its key
        throw e;
      }
    },

    async start(h, req) {
      const post = buildRunnerPost({ endpoint: h.endpoint, authToken: h.authToken, repoUrl: req.repoUrl, task: req.task, testCommand: req.testCommand });
      const r = await call(post.url, { method: post.method, headers: post.headers, body: post.body });
      if (r.status !== 202) throw new Error(`runner rejected the task: HTTP ${r.status} ${await r.text()}`);
    },

    async poll(h, since): Promise<PollResult> {
      const r = await call(`https://${h.endpoint}/events?since=${since}`, { headers: auth(h) });
      if (!r.ok) throw new Error(`events poll failed: HTTP ${r.status}`);
      return r.json();
    },

    terminate,
  };
}
