import { railSteps, type RunView } from "./run-view.ts";

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
