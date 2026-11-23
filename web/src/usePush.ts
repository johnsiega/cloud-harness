import { useCallback, useEffect, useReducer, useState } from "react";
import { initialPush, reducePush, type PushConfig } from "./push-state.ts";

// Loads whether push is configured, and runs the push. Remounted per run (keyed by run id), so state never leaks between runs.
export function usePush(runId: string | undefined) {
  const [state, dispatch] = useReducer(reducePush, undefined, initialPush);
  const [cfg, setCfg] = useState<PushConfig | undefined>();

  useEffect(() => {
    let live = true;
    fetch("/config")
      .then((r) => r.json())
      .then((c: PushConfig) => { if (live) setCfg(c); })
      .catch(() => { if (live) setCfg({ pushEnabled: false }); });
    return () => { live = false; };
  }, []);

  const push = useCallback(async () => {
    if (!runId) return;
    dispatch({ type: "start" });
    try {
      const res = await fetch(`/runs/${runId}/push`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = await res.json().catch(() => ({}));
      if (res.ok) dispatch({ type: "success", branch: body.branch, commit: body.commit, url: body.url });
      else dispatch({ type: "failure", status: res.status, body });
    } catch {
      dispatch({ type: "failure", status: 0, body: {} });
    }
  }, [runId]);

  return { cfg, state, push };
}
