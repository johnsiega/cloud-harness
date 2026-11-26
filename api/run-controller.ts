// One run, start to finish: launch -> stream parsed events into the store -> decide the outcome -> always terminate.
// Never rejects: every failure becomes stderr + done(1) on the run, so the HTTP layer can fire-and-forget it.
import { createEventParser } from "./event-parser.ts";
import type { MicroVMLauncher, Redactor, RunStore, SandboxHandle, TraceEvent } from "./types.ts";

export interface ExecDeps {
  store: RunStore;
  launcher: MicroVMLauncher;
  redact: Redactor;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
}

export async function executeRun(d: ExecDeps, id: string): Promise<void> {
  const { store, launcher, redact, now } = d;
  const pollMs = d.pollMs ?? 500;
  const maxPolls = d.maxPolls ?? 2400; // 20 min at 500 ms
  let handle: SandboxHandle | undefined;

  const emit = (e: TraceEvent) => store.append(id, redact.event(e));
  const fail = (e: unknown) => {
    emit({ type: "stderr", ts: now(), text: e instanceof Error ? e.message : String(e) });
    store.update(id, { status: "error" });
    emit({ type: "done", ts: now(), exitCode: 1 });
  };

  try {
    const rec = store.get(id);
    if (!rec) return;
    store.update(id, { status: "running" });
    emit({ type: "sandbox_resuming", ts: now() });

    try {
      handle = await launcher.launch(rec.request, id);
    } catch (e) {
      return fail(e);
    }
    store.update(id, { microvmId: handle.microvmId, startupMs: handle.readyMs - handle.submitMs });
    emit({ type: "sandbox_ready", ts: now(), startupMs: handle.readyMs - handle.submitMs });

    try {
      await launcher.start(handle, rec.request);

      const parser = createEventParser({ now });
      let since = 0;
      let finished = false;
      let tail: string[] = [];
      let firstToken = false;
      let baseSaved = false;
      let testExit: number | null = null;
      let diff: string | undefined;

      for (let i = 0; i < maxPolls && !finished; i++) {
        const r = await launcher.poll(handle, since);
        since = r.next;
        const events = parser.push(r.lines.map((l) => l + "\n").join(""));
        if (r.done) { events.push(...parser.end()); tail = r.stderrTail; finished = true; }
        if (parser.baseCommit && !baseSaved) { baseSaved = true; store.update(id, { baseCommit: parser.baseCommit }); }
        for (const e of events) {
          if (e.type === "reasoning" && !firstToken) { firstToken = true; store.update(id, { firstTokenMs: e.ts - handle.submitMs }); }
          if (e.type === "test_result") testExit = e.exitCode;
          if (e.type === "diff") diff = e.diff;
          emit(e);
        }
        if (!finished) await d.sleep(pollMs);
      }
      if (!finished) throw new Error(`run timed out after ${maxPolls} polls`);

      const hasDiff = diff !== undefined && diff.trim() !== "";
      const ok = parser.codexExit === 0 && testExit === 0 && hasDiff;
      if (!hasDiff) emit({ type: "stderr", ts: now(), text: "no changes were produced (empty or missing diff)" });
      if (testExit === null) emit({ type: "stderr", ts: now(), text: "the test step did not report a result" });
      if (!ok) for (const l of tail) emit({ type: "stderr", ts: now(), text: l }); // runner stderr is only worth showing on failure
      if (diff !== undefined) store.update(id, { diff: redact.text(diff) });
      store.update(id, { status: ok ? "done" : "error" });
      emit({ type: "done", ts: now(), exitCode: ok ? 0 : testExit && testExit !== 0 ? testExit : 1 });
    } catch (e) {
      fail(e);
    }
  } catch {
    /* the store itself failed (e.g. record expired): nothing left to report to */
  } finally {
    if (handle) await launcher.terminate(handle);
  }
}
