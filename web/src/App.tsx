import { useEffect, useState } from "react";
import { RunForm } from "./RunForm.tsx";
import { SimulationView } from "./SimulationView.tsx";
import { RunRail } from "./RunRail.tsx";
import { TracePanels } from "./TracePanels.tsx";
import { formatMs } from "./run-view.ts";
import { useRun } from "./useRun.ts";

function useElapsed(since: number | undefined, running: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [running]);
  return since === undefined ? undefined : now - since;
}

const STATUS: Record<string, string> = {
  idle: "Ready for a task",
  resuming: "Resuming the sandbox",
  ready: "Sandbox ready",
  running: "Agent working",
  done: "Finished",
  error: "Finished with errors",
};

export default function App() {
  const { view, meta, submit } = useRun();
  const [tab, setTab] = useState<"live" | "sim">("live");
  const [demo, setDemo] = useState(false);
  // Demo mode (no key or image): open on the simulation, and say why real runs are off.
  useEffect(() => {
    fetch("/config").then((r) => r.json()).then((c) => { if (c.demo) { setDemo(true); setTab("sim"); } }).catch(() => {});
  }, []);
  const active = meta.submitting;
  const elapsed = useElapsed(meta.submittedAt, active);

  return (
    <main className="app">
      <header className="top">
        <h1>Cloud harness</h1>
        <p className="tag">Run a coding agent inside a Lambda MicroVM and watch it work.</p>
        <p className={`status ${view.phase}`} role="status">
          <span className="dot" aria-hidden="true" />
          {STATUS[view.phase]}
          {active && elapsed !== undefined && <span className="elapsed">{formatMs(elapsed)}</span>}
        </p>
      </header>

      <nav className="tabs" role="tablist" aria-label="View">
        <button role="tab" aria-selected={tab === "live"} className={tab === "live" ? "on" : ""} onClick={() => setTab("live")}>Live run</button>
        <button role="tab" aria-selected={tab === "sim"} className={tab === "sim" ? "on" : ""} onClick={() => setTab("sim")}>Simulation</button>
      </nav>

      {tab === "sim" ? <SimulationView /> : (
        <>
      {demo && <p className="note" role="note">Demo mode: real runs are disabled because no OpenRouter key or MicroVM image is configured. Use the Simulation tab.</p>}
      <RunForm busy={active || demo} onSubmit={submit} />
      {meta.notice && <p className="note">{meta.notice}</p>}
      {meta.error && <p className="note error" role="alert">{meta.error}</p>}

      <RunRail view={view} />
      <TracePanels view={view} runId={meta.runId} />
        </>
      )}
    </main>
  );
}
