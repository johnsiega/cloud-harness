import { useEffect, useRef, useState } from "react";
import { diffLines, formatMs, type RunView } from "./run-view.ts";

function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [dep]);
  return ref;
}

function ReasoningPanel({ view }: { view: RunView }) {
  const ref = useStickToBottom(view.reasoning.length);
  return (
    <section className="panel reasoning" aria-labelledby="h-reasoning">
      <header><h2 id="h-reasoning">Reasoning</h2><span className="count">{view.reasoning.length}</span></header>
      <div className="body" ref={ref} tabIndex={0}>
        {view.reasoning.length === 0 && <p className="empty">The agent's messages appear here as it works.</p>}
        {view.reasoning.map((r, i) => (
          <article key={i} className="msg">
            <time>{view.startedAt !== undefined ? `+${formatMs(r.ts - view.startedAt)}` : ""}</time>
            <p>{r.text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function TerminalPanel({ view }: { view: RunView }) {
  const ref = useStickToBottom(view.terminal.length);
  return (
    <section className="panel terminal" aria-labelledby="h-terminal">
      <header>
        <h2 id="h-terminal">Terminal</h2>
        {view.test && <span className={`badge ${view.test.exitCode === 0 ? "ok" : "fail"}`}>{view.test.summary}</span>}
      </header>
      <div className="body" ref={ref} tabIndex={0}>
        {view.terminal.length === 0 && <p className="empty">Commands and their output show up here.</p>}
        {view.terminal.map((t, i) => {
          const [first, ...rest] = t.text.split("\n");
          const isCmd = t.kind === "stdout" && first.startsWith("$ ");
          return (
            <pre key={i} className={`out ${t.kind}`}>
              {isCmd ? <><span className="prompt">$</span>{first.slice(1)}</> : first}
              {rest.length > 0 && "\n" + rest.join("\n")}
            </pre>
          );
        })}
      </div>
    </section>
  );
}

function DiffPanel({ view }: { view: RunView }) {
  const [copied, setCopied] = useState(false);
  const lines = view.diff ? diffLines(view.diff) : [];
  const files = lines.filter((l) => l.kind === "meta" && l.text.startsWith("diff --git")).map((l) => l.text.replace(/^diff --git a\/(.+) b\/.+$/, "$1"));
  const added = lines.filter((l) => l.kind === "add").length;
  const removed = lines.filter((l) => l.kind === "del").length;
  const copy = async () => {
    try { await navigator.clipboard.writeText(view.diff ?? ""); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  return (
    <section className="panel diff" aria-labelledby="h-diff">
      <header>
        <h2 id="h-diff">Diff</h2>
        {view.diff ? <span className="stat"><b className="plus">+{added}</b> <b className="minus">−{removed}</b></span> : null}
        {view.diff ? <button type="button" className="ghost" onClick={copy}>{copied ? "Copied" : "Copy diff"}</button> : null}
      </header>
      <div className="body" tabIndex={0}>
        {view.diff === undefined && <p className="empty">The patch appears here when the run finishes.</p>}
        {view.diff !== undefined && view.diff.trim() === "" && <p className="empty">The run finished without changing any files.</p>}
        {files.length > 0 && <p className="files">{files.join(", ")}</p>}
        {lines.map((l, i) => (
          // The +/− lives in the gutter (::before), so the text drops its own leading marker.
          <div key={i} className={`dl ${l.kind}`}>{(l.kind === "add" || l.kind === "del" ? l.text.slice(1) : l.text) || " "}</div>
        ))}
      </div>
    </section>
  );
}

export function TracePanels({ view }: { view: RunView }) {
  return (
    <div className="panels">
      <ReasoningPanel view={view} />
      <TerminalPanel view={view} />
      <DiffPanel view={view} />
    </div>
  );
}
