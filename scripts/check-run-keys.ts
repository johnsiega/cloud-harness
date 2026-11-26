// $0 check of per-run OpenRouter keys: are deleted and expired keys refused? Prints labels and HTTP statuses only.
//   node scripts/check-run-keys.ts          creates two tiny keys, reads GET /api/v1/key with each (no model call), deletes them; ~80 s
//   node scripts/check-run-keys.ts --list   names and expiry of the per-run keys that still exist
// Needs OPENROUTER_MANAGEMENT_KEY in .env. No key is ever printed.
import { join } from "node:path";
import { loadDotEnv } from "../api/main.ts";
import { createRunKeys, type RunKeys } from "../api/openrouter-keys.ts";
import type { FetchLike } from "../api/types.ts";

const API = "https://openrouter.ai/api/v1";
const refused = (status: number) => status === 401 || status === 403;

export async function checkRunKeys(d: { keys: RunKeys; fetch: FetchLike; sleep: (ms: number) => Promise<void>; log: (s: string) => void }): Promise<0 | 1> {
  const open = new Set<string>(); // hashes still to delete
  let ok = true;
  const expect = (label: string, pass: boolean) => { if (!pass) ok = false; d.log(label); };
  const status = async (key: string) => (await d.fetch(`${API}/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })).status;
  const drop = async (hash: string) => {
    open.delete(hash);
    try { await d.keys.delete(hash); } catch (e) { ok = false; d.log(`${(e as Error).message}; delete it in the OpenRouter dashboard`); }
  };
  try {
    for (const [name, ttlMs] of [["deleted", undefined], ["expired", 60_000]] as const) {
      const { key, hash } = await d.keys.create(`throwbox-check-${Date.now()}`, ttlMs);
      open.add(hash);
      const fresh = await status(key);
      expect(`new key accepted: HTTP ${fresh}`, fresh === 200);
      if (fresh !== 200) break; // a refusal later would prove nothing
      if (name === "deleted") await drop(hash);
      else await d.sleep(75_000);
      const after = await status(key);
      expect(`${name} key refused: ${refused(after) ? "yes" : "no"} (HTTP ${after})`, refused(after));
    }
  } catch (e) {
    // Only our own fixed errors are printed: a fetch error message could echo a header.
    const m = (e as Error).message;
    expect(m.startsWith("could not") ? m : "check failed (request error)", false);
  } finally {
    for (const hash of [...open]) await drop(hash);
  }
  return ok ? 0 : 1;
}

export async function listRunKeys(d: { managementKey: string; fetch: FetchLike; log: (s: string) => void }): Promise<0 | 1> {
  let offset = 0;
  let found = 0;
  for (;;) {
    const r = await d.fetch(`${API}/keys?include_disabled=true&include_expired=true&offset=${offset}`,
      { headers: { Authorization: `Bearer ${d.managementKey}` }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) { d.log(`could not list keys (HTTP ${r.status})`); return 1; }
    const rows: { name?: string; expires_at?: string | null }[] = (await r.json()).data ?? [];
    if (rows.length === 0) break;
    for (const k of rows) if (k.name?.startsWith("throwbox-run-")) { found++; d.log(`${k.name}  expires_at ${k.expires_at ?? "never"}`); }
    offset += rows.length;
  }
  d.log(`${found} per-run key(s) exist`);
  return 0;
}

if (process.argv[1] && /check-run-keys\.ts$/.test(process.argv[1])) {
  loadDotEnv(join(import.meta.dirname, "..", ".env"));
  const managementKey = process.env.OPENROUTER_MANAGEMENT_KEY?.trim();
  if (!managementKey) {
    console.error("set OPENROUTER_MANAGEMENT_KEY in .env first");
    process.exitCode = 1;
  } else {
    const fetchIt: FetchLike = (url, init) => fetch(url, init);
    const log = (s: string) => console.log(s);
    const done = process.argv.includes("--list")
      ? listRunKeys({ managementKey, fetch: fetchIt, log })
      : checkRunKeys({ keys: createRunKeys({ managementKey, limitUsd: 0.01 }), fetch: fetchIt, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log });
    done.then((code) => { process.exitCode = code; }, () => { console.error("request error"); process.exitCode = 1; });
  }
}
