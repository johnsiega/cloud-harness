// POST /simulate?n= and GET /simulate/:id/stream: n synthetic runs over ONE SSE connection. Never touches the RunStore, launcher or push.
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { MAX_RUNS, planSimulation, simulationEvents } from "./simulation.ts";
import type { SimEvent } from "./simulation.ts";
import { formatSse } from "./sse.ts";

export interface SimDeps {
  /** Runs fn after ms and returns a cancel function. Injected so tests never wait. */
  schedule: (fn: () => void, ms: number) => () => void;
  newId?: () => string;
  seed?: () => number;
}

const IDLE_TTL_MS = 60_000; // a simulation nobody connects to stops blocking new ones after this

const realSchedule: SimDeps["schedule"] = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

type Sim = { n: number; events: SimEvent[]; state: "created" | "streaming" | "finished"; cancel: (() => void)[] };

export function registerSimulation(app: Hono, deps?: SimDeps): void {
  const schedule = deps?.schedule ?? realSchedule;
  const newId = deps?.newId ?? randomUUID;
  const seed = deps?.seed ?? (() => Math.floor(Math.random() * 2 ** 31));
  const sims = new Map<string, Sim>();
  const active = () => [...sims.values()].some((s) => s.state !== "finished");
  const finish = (s: Sim) => { s.state = "finished"; s.cancel.splice(0).forEach((c) => c()); };

  app.post("/simulate", (c) => {
    const raw = c.req.query("n") ?? "";
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_RUNS) return c.json({ error: `n must be an integer from 1 to ${MAX_RUNS}` }, 400);
    if (active()) return c.json({ error: "a simulation is already running" }, 409);
    const id = newId();
    const sim: Sim = { n, events: simulationEvents(planSimulation({ n, seed: seed() })), state: "created", cancel: [] };
    sim.cancel.push(schedule(() => { if (sim.state === "created") finish(sim); }, IDLE_TTL_MS));
    sims.set(id, sim);
    return c.json({ id }, 202);
  });

  app.get("/simulate/:id/stream", (c) => {
    const sim = sims.get(c.req.param("id"));
    // 204 stops EventSource's automatic reconnect; without it a finished simulation would be replayed forever.
    if (!sim || sim.state !== "created") return c.body(null, 204);
    sim.state = "streaming";
    sim.cancel.splice(0).forEach((x) => x()); // drop the idle-expiry timer
    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        let chain: Promise<unknown> = Promise.resolve();
        const end = () => { finish(sim); resolve(); };
        const send = (frame: string) => { chain = chain.then(() => stream.write(frame)); };
        stream.onAbort(end);
        for (const e of sim.events) {
          sim.cancel.push(schedule(() => send(formatSse({ ...e.event, simulated: true } as any, e.runId)), e.at));
        }
        const last = sim.events.at(-1)?.at ?? 0;
        sim.cancel.push(schedule(() => {
          send(`event: simulation_done\ndata: ${JSON.stringify({ simulated: true, n: sim.n })}\n\n`);
          chain = chain.then(end);
        }, last));
      });
    });
  });
}
