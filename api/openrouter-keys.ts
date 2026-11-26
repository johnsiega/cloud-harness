// Per-run OpenRouter keys through the management API. fetch is injected so tests never touch the network.
// The management key goes only in the Authorization header to openrouter.ai; every error string is fixed, so no key or server text leaks.
import type { FetchLike } from "./types.ts";

export interface RunKeys {
  create(label: string, ttlMs?: number): Promise<{ key: string; hash: string }>;
  delete(hash: string): Promise<void>;
}

const KEYS = "https://openrouter.ai/api/v1/keys";
const HASH = /^[A-Za-z0-9_-]{1,128}$/;
const TTL_MS = 30 * 60_000; // the VM's maximumDurationInSeconds (1800)
const LIMIT_ERROR = "RUN_KEY_LIMIT_USD must be a positive number of US dollars below 1000000";

export function createRunKeys(o: { managementKey: string; limitUsd: number; fetch?: FetchLike; now?: () => number; timeoutMs?: number }): RunKeys {
  const doFetch: FetchLike = o.fetch ?? ((url, init) => fetch(url, init));
  const now = o.now ?? Date.now;
  const call = async (method: string, url: string, body?: unknown) => {
    try {
      return await doFetch(url, {
        method,
        headers: { Authorization: `Bearer ${o.managementKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
    } catch { return null; } // network error or timeout; the exception text is never used
  };
  return {
    async create(label, ttlMs = TTL_MS) {
      const fail = (why: string) => new Error(`could not create a per-run OpenRouter key (${why})`);
      const r = await call("POST", KEYS, { name: label, limit: o.limitUsd, expires_at: new Date(now() + ttlMs).toISOString() });
      if (!r) throw fail("OpenRouter unreachable");
      if (r.status !== 201) throw fail(`HTTP ${r.status}`);
      const j = await r.json().catch(() => null);
      const key = j?.key, hash = j?.data?.hash;
      if (typeof key !== "string" || !key.startsWith("sk-or-") || typeof hash !== "string" || !HASH.test(hash)) throw fail("unexpected answer");
      return { key, hash };
    },
    async delete(hash) {
      if (!HASH.test(hash)) throw new Error("invalid key hash");
      const r = await call("DELETE", `${KEYS}/${hash}`);
      if (!r) throw new Error("could not delete the per-run OpenRouter key (OpenRouter unreachable)");
      if (r.status !== 200 && r.status !== 404) throw new Error(`could not delete the per-run OpenRouter key (HTTP ${r.status})`); // 404: already gone
    },
  };
}

export function parseRunKeyLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0.1;
  const n = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN; // plain decimals only: no "1e6", "0x10", "Infinity" or blanks
  if (!(n > 0 && n < 1_000_000)) throw new Error(LIMIT_ERROR);
  return n;
}
