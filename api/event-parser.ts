// Runner stdout (Codex JSONL + runner events + a __DIFF_START__/__DIFF_END__ block) -> TraceEvents.
// Stateful and chunk-safe: partial lines (and diff markers split across chunks) are buffered until their newline arrives.
import type { TraceEvent } from "./types.ts";

export interface EventParser {
  push(chunk: string): TraceEvent[];
  end(): TraceEvent[];
  readonly codexExit: number | null;
}

type Json = Record<string, any>;

export function createEventParser(o: { now?: () => number } = {}): EventParser {
  const now = o.now ?? Date.now;
  let buf = "";
  let inDiff = false;
  let diffLines: string[] = [];
  let codexExit: number | null = null;

  const mapJson = (j: Json, out: TraceEvent[]) => {
    const ts = now();
    if (j.type === "item.completed" && j.item) {
      const i = j.item as Json;
      if (i.type === "agent_message" || i.type === "reasoning") out.push({ type: "reasoning", ts, text: String(i.text ?? "") });
      else if (i.type === "command_execution") {
        const output = String(i.aggregated_output ?? "").trimEnd();
        out.push({ type: "stdout", ts, text: `$ ${i.command}` + (output ? `\n${output}` : "") });
      } else if (i.type === "file_change") {
        out.push({ type: "stdout", ts, text: `file_change: ${((i.changes ?? []) as Json[]).map((c) => `${c.path} (${c.kind})`).join(", ")}` });
      } else if (i.type === "error") out.push({ type: "stderr", ts, text: String(i.message ?? "") });
    } else if (j.type === "error") out.push({ type: "stderr", ts, text: String(j.message ?? "") });
    else if (j.type === "turn.failed") out.push({ type: "stderr", ts, text: String(j.error?.message ?? "") });
    else if (j.type === "codex_exit") codexExit = Number(j.exitCode);
    else if (j.type === "test_result") {
      const exitCode = Number(j.exitCode);
      out.push({ type: "test_result", ts, exitCode, summary: exitCode === 0 ? "tests passed" : `tests failed (exit ${exitCode})` });
    }
  };

  const line = (raw: string, out: TraceEvent[]) => {
    const marker = raw.replace(/\r$/, "");
    if (inDiff) {
      if (marker === "__DIFF_END__") {
        out.push({ type: "diff", ts: now(), diff: diffLines.map((l) => l + "\n").join("") });
        inDiff = false;
        diffLines = [];
      } else diffLines.push(raw);
      return;
    }
    if (marker.trim() === "") return;
    if (marker === "__DIFF_START__") { inDiff = true; diffLines = []; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(marker); } catch { parsed = undefined; }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) mapJson(parsed as Json, out);
    else out.push({ type: "stdout", ts: now(), text: marker });
  };

  return {
    push(chunk) {
      const out: TraceEvent[] = [];
      buf += chunk;
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const p of parts) line(p, out);
      return out;
    },
    end() {
      const out: TraceEvent[] = [];
      if (buf) { line(buf, out); buf = ""; }
      if (inDiff) {
        out.push({ type: "stderr", ts: now(), text: "diff block was not terminated" });
        inDiff = false;
        diffLines = [];
      }
      return out;
    },
    get codexExit() { return codexExit; },
  };
}
