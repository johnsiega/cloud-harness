// SSE wire format: `event: <type>\ndata: <json>\n\n`. JSON.stringify escapes newlines, so a multi-line diff stays on ONE data line.
import type { TraceEvent } from "./types.ts";

export function formatSse(e: TraceEvent, runId?: string): string {
  const payload = runId === undefined ? e : { runId, ...e };
  return `event: ${e.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}
