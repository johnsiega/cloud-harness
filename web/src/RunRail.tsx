import { diffLines, formatMs, type RunView } from "./run-view.ts";

type Tone = "pending" | "active" | "ok" | "fail";
type Step = { key: string; label: string; tone: Tone; detail?: string; hero?: string };

// Derive the four-step rail from the view. Pure; the reducer already did the hard work.
export function railSteps(v: RunView): Step[] {
  const finished = v.phase === "done" || v.phase === "error";
  const sandbox: Step = v.startupMs !== undefined
    ? { key: "sandbox", label: "Sandbox ready", tone: "ok", hero: formatMs(v.startupMs), detail: "snapshot resume" }
    : { key: "sandbox", label: "Sandbox", tone: v.phase === "resuming" ? "active" : finished ? "fail" : "pending", detail: v.phase === "resuming" ? "resuming snapshot" : undefined };

  const agentStarted = v.phase === "ready" || v.phase === "running" || finished;
  const agentDone = v.test !== undefined || v.diff !== undefined || (finished && v.reasoning.length + v.terminal.length > 0);
  const agent: Step = {
    key: "agent", label: "Agent",
    tone: agentDone ? "ok" : agentStarted ? "active" : "pending",
    detail: v.firstTokenMs !== undefined ? `first output ${formatMs(v.firstTokenMs)}` : agentStarted ? "waiting for first output" : undefined,
  };

  const tests: Step = v.test
    ? { key: "tests", label: v.test.exitCode === 0 ? "Tests passed" : "Tests failed", tone: v.test.exitCode === 0 ? "ok" : "fail", detail: v.test.exitCode === 0 ? undefined : `exit ${v.test.exitCode}` }
    : { key: "tests", label: "Tests", tone: agentDone ? "fail" : "pending" };

  const lines = v.diff ? diffLines(v.diff) : [];
  const added = lines.filter((l) => l.kind === "add").length;
  const removed = lines.filter((l) => l.kind === "del").length;
  const patch: Step = v.diff === undefined
    ? { key: "patch", label: "Patch", tone: finished ? "fail" : "pending" }
    : v.diff.trim() === ""
      ? { key: "patch", label: "No changes", tone: "fail" }
      : { key: "patch", label: "Patch ready", tone: "ok", detail: `+${added} −${removed}` };
  return [sandbox, agent, tests, patch];
}

export function RunRail({ view }: { view: RunView }) {
  const steps = railSteps(view);
  return (
    <ol className="rail" aria-label="Run progress">
      {steps.map((s) => (
        <li key={s.key} className={`step ${s.tone}`} aria-current={s.tone === "active" ? "step" : undefined}>
          <span className="node" aria-hidden="true" />
          <span className="what">
            <span className="label">{s.label}</span>
            {s.hero && <span className="hero">{s.hero}</span>}
            {s.detail && <span className="detail">{s.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
