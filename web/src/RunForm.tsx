import { useState, type FormEvent } from "react";
import type { RunRequest } from "../../api/types.ts";

const DEFAULT_REPO = "https://github.com/jyvnn/hospital-queue";
const DEFAULT_TASK = "Add a one-line comment directly above the enabled() method in app/Services/QueueEventLog.php explaining what it checks. Do not change any behavior.";

export function RunForm({ busy, onSubmit }: { busy: boolean; onSubmit: (req: RunRequest) => void }) {
  const [repoUrl, setRepoUrl] = useState(DEFAULT_REPO);
  const [task, setTask] = useState(DEFAULT_TASK);
  const [model, setModel] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({ repoUrl: repoUrl.trim(), task: task.trim(), ...(model.trim() ? { model: model.trim() } : {}) });
  };

  return (
    <form className="runform" onSubmit={submit}>
      <label className="field repo">
        <span>Repository</span>
        <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} spellCheck={false} inputMode="url" placeholder="https://github.com/owner/repo" required />
      </label>
      <label className="field model">
        <span>Model</span>
        <input value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} placeholder="deepseek/deepseek-v4.1-flash" />
      </label>
      <label className="field task">
        <span>Task for the agent</span>
        <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} required />
      </label>
      <button className="run" type="submit" disabled={busy || !repoUrl.trim() || !task.trim()}>
        {busy ? "Running" : "Run task"}
      </button>
    </form>
  );
}
