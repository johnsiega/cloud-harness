import { useCallback, useEffect, useRef, useState } from "react";
import { initialView, reduce, type RunView } from "./run-view.ts";
import type { RunRequest, TraceEvent } from "../../api/types.ts";

const EVENT_TYPES = ["sandbox_resuming", "sandbox_ready", "reasoning", "stdout", "stderr", "test_result", "diff", "done"] as const;

export type RunMeta = { runId?: string; submitting: boolean; error?: string; notice?: string; submittedAt?: number };

// One POST to start the run, then one EventSource for the parsed trace. Every event goes through the pure reducer.
export function useRun() {
  const [view, setView] = useState<RunView>(initialView());
  const [meta, setMeta] = useState<RunMeta>({ submitting: false });
  const source = useRef<EventSource | null>(null);
  const finished = useRef(false);

  const close = useCallback(() => { source.current?.close(); source.current = null; }, []);
  useEffect(() => close, [close]);

  const attach = useCallback((id: string) => {
    close();
    finished.current = false;
    const es = new EventSource(`/runs/${id}/stream`);
    source.current = es;
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (m) => {
        const { runId: _runId, ...event } = JSON.parse((m as MessageEvent).data);
        setView((v) => reduce(v, event as TraceEvent));
        if (type === "done") {
          finished.current = true;
          es.close();
          setMeta((s) => ({ ...s, submitting: false }));
        }
      });
    }
    es.onerror = () => {
      if (finished.current) return;
      es.close();
      setMeta((s) => ({ ...s, submitting: false, error: "Lost the connection to the control plane before the run finished." }));
    };
  }, [close]);

  const submit = useCallback(async (req: RunRequest) => {
    close();
    setView(initialView());
    setMeta({ submitting: true, submittedAt: Date.now() });
    try {
      const res = await fetch("/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
      const body = await res.json();
      if (res.status === 409) {
        setMeta((s) => ({ ...s, runId: body.existingId, notice: "That task is already running, so this shows the existing run." }));
        attach(body.existingId);
      } else if (!res.ok) {
        setMeta({ submitting: false, error: body.error ?? `The control plane answered ${res.status}.` });
      } else {
        setMeta((s) => ({ ...s, runId: body.id }));
        attach(body.id);
      }
    } catch {
      setMeta({ submitting: false, error: "Can't reach the control plane. Start it with npm start (it listens on 127.0.0.1:3000)." });
    }
  }, [attach, close]);

  return { view, meta, submit };
}
