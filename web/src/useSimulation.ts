import { useCallback, useEffect, useRef, useState } from "react";
import { createBatcher, finishSimulation, initialSim, reduceSimulation, type SimMessage, type SimState } from "./simulation-view.ts";
import type { TraceEvent } from "../../api/types.ts";

const EVENT_TYPES = ["sandbox_resuming", "sandbox_ready", "reasoning", "stdout", "stderr", "test_result", "diff", "done"] as const;

export type SimMeta = { starting: boolean; streaming: boolean; error?: string };

// POST /simulate, then ONE EventSource for every run. Messages are batched per animation frame before they reach the reducer.
export function useSimulation() {
  const [state, setState] = useState<SimState>(initialSim());
  const [meta, setMeta] = useState<SimMeta>({ starting: false, streaming: false });
  const source = useRef<EventSource | null>(null);
  const batcher = useRef<ReturnType<typeof createBatcher<SimMessage | "finish">> | null>(null);

  const close = useCallback(() => { source.current?.close(); source.current = null; }, []);
  useEffect(() => close, [close]);

  const start = useCallback(async (n: number) => {
    close();
    setState(initialSim());
    setMeta({ starting: true, streaming: false });
    batcher.current = createBatcher<SimMessage | "finish">({
      requestFrame: (cb) => requestAnimationFrame(cb),
      onFlush: (items) => setState((s) => items.reduce<SimState>((acc, m) => (m === "finish" ? finishSimulation(acc) : reduceSimulation(acc, m)), s)),
    });
    try {
      const res = await fetch(`/simulate?n=${n}`, { method: "POST", headers: { "content-type": "application/json" } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setMeta({ starting: false, streaming: false, error: body.error ?? `The control plane answered ${res.status}.` }); return; }
      const es = new EventSource(`/simulate/${body.id}/stream`);
      source.current = es;
      setMeta({ starting: false, streaming: true });
      for (const type of EVENT_TYPES) {
        es.addEventListener(type, (m) => {
          const { runId, simulated: _s, ...event } = JSON.parse((m as MessageEvent).data);
          batcher.current?.push({ runId, event: event as TraceEvent });
        });
      }
      es.addEventListener("simulation_done", () => {
        batcher.current?.push("finish");
        es.close();
        setMeta({ starting: false, streaming: false });
      });
      es.onerror = () => { es.close(); setMeta((s) => (s.streaming ? { starting: false, streaming: false, error: "Lost the simulation stream before it finished." } : s)); };
    } catch {
      setMeta({ starting: false, streaming: false, error: "Can't reach the control plane. Start it with npm start (it listens on 127.0.0.1:3000)." });
    }
  }, [close]);

  return { state, meta, start };
}
