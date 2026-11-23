// In-memory Map<string, RunRecord> with a TTL. Reads return snapshots so callers can't corrupt the store.
import type { RunRecord, RunStore, TraceEvent } from "./types.ts";

export function createRunStore(o: { now?: () => number; ttlMs?: number; newId?: () => string } = {}): RunStore {
  const now = o.now ?? Date.now;
  const ttlMs = o.ttlMs ?? 60 * 60_000;
  const newId = o.newId ?? (() => crypto.randomUUID());
  const runs = new Map<string, RunRecord>();
  const subs = new Map<string, Set<(e: TraceEvent) => void>>();

  const expired = (r: RunRecord) => now() - r.createdAt >= ttlMs;
  const drop = (id: string) => { runs.delete(id); subs.delete(id); };
  const live = (id: string): RunRecord | undefined => {
    const r = runs.get(id);
    if (!r) return undefined;
    if (expired(r)) { drop(id); return undefined; }
    return r;
  };
  const need = (id: string) => live(id) ?? (() => { throw new Error(`unknown run: ${id}`); })();

  return {
    create(req) {
      for (const r of runs.values()) {
        if (!expired(r) && (r.status === "pending" || r.status === "running") && r.request.repoUrl === req.repoUrl && r.request.task === req.task) {
          return { ok: false, reason: "duplicate", existingId: r.id };
        }
      }
      const record: RunRecord = { id: newId(), request: { ...req }, status: "pending", events: [], createdAt: now() };
      runs.set(record.id, record);
      return { ok: true, record: structuredClone(record) };
    },
    get(id) {
      const r = live(id);
      return r ? structuredClone(r) : undefined;
    },
    append(id, e) {
      const r = need(id);
      r.events.push(e);
      for (const fn of subs.get(id) ?? []) {
        try { fn(e); } catch { /* one bad subscriber must not break the others */ }
      }
    },
    update(id, patch) {
      const r = need(id);
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (r as any)[k] = v;
    },
    subscribe(id, fn) {
      const r = need(id);
      for (const e of [...r.events]) {
        try { fn(e); } catch { /* ignore */ }
      }
      const set = subs.get(id) ?? new Set();
      set.add(fn);
      subs.set(id, set);
      return () => { set.delete(fn); };
    },
    sweep() {
      let n = 0;
      for (const [id, r] of [...runs]) if (expired(r)) { drop(id); n++; }
      return n;
    },
  };
}
