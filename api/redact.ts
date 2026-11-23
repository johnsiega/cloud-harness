// Redaction: exact secret values plus known token prefixes become [REDACTED] before anything is stored or streamed.
import type { Redactor, TraceEvent } from "./types.ts";

const MARK = "[REDACTED]";
const TOKEN_PREFIXES = /(?:sk-or-|github_pat_|ghp_)[A-Za-z0-9_-]+/g;

export function createRedactor(secrets: string[]): Redactor {
  // Longest first so a secret that contains another is replaced whole; split/join keeps matching literal (no regex).
  const exact = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const text = (s: string): string => {
    let out = s;
    for (const secret of exact) out = out.split(secret).join(MARK);
    return out.replace(TOKEN_PREFIXES, MARK);
  };
  const event = (e: TraceEvent): TraceEvent => {
    const copy: Record<string, unknown> = { ...e };
    for (const [k, v] of Object.entries(copy)) if (k !== "type" && typeof v === "string") copy[k] = text(v);
    return copy as TraceEvent;
  };
  return { text, event };
}
