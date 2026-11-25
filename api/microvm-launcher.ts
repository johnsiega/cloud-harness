// Launches one MicroVM and talks to its in-VM runner. AWS and fetch are injected so this is unit-testable.
// The OpenRouter key travels ONLY in the run hook payload (never env, never URL/header/body of runner calls).
import { buildRunRequest, buildRunnerPost } from "../scripts/smoke-test.ts";
import type { AwsMicrovms, FetchLike, MicroVMLauncher, PollResult, SandboxHandle } from "./types.ts";

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

  const terminate = async (h: Pick<SandboxHandle, "microvmId">) => {
    try { await o.aws.terminate(h.microvmId); } catch { /* best effort: cleanup must never mask the real error */ }
  };

  return {
    async launch(req) {
      // Validates the repo URL, model id and payload size before anything is created in AWS.
      const input = buildRunRequest({ imageArn: o.imageArn, repoUrl: req.repoUrl, task: req.task, apiKey: o.apiKey, region: o.region, model: req.model });
      const submitMs = now();
      const { microvmId, endpoint } = await o.aws.run(input);
      try {
        const authToken = await o.aws.authToken(microvmId);
        for (;;) {
          try {
            const r = await call(`https://${endpoint}/health`, { headers: auth({ authToken }) });
            if (r.ok) return { microvmId, endpoint, authToken, submitMs, readyMs: now() };
          } catch { /* endpoint not routable yet */ }
          if (now() - submitMs >= readyTimeoutMs) throw new Error(`sandbox not ready after ${readyTimeoutMs} ms`);
          await sleep(readyPollMs);
        }
      } catch (e) {
        await terminate({ microvmId }); // don't leak a half-started MicroVM
        throw e;
      }
    },

    async start(h, req) {
      const post = buildRunnerPost({ endpoint: h.endpoint, authToken: h.authToken, repoUrl: req.repoUrl, task: req.task });
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
