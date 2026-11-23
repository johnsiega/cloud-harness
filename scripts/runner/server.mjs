// Idle HTTP runner inside the MicroVM (port 8080). Lambda snapshots it idle; after restore:
//   POST /aws/lambda-microvms/runtime/v1/run  <- Lambda delivers runHookPayload (key + model), returns 200
//   POST /            {repoUrl, task}         <- control plane starts the run (once)
//   GET  /events?since=N                      <- control plane polls JSONL lines
//   GET  /health
import http from "node:http";
import { spawn } from "node:child_process";

const HOOK = "/aws/lambda-microvms/runtime/v1/";
const PORT = Number(process.env.PORT) || 8080;
const RUN_TASK_SCRIPT = process.env.RUN_TASK_SCRIPT || "/opt/runner/run-task.sh";
const BASH = process.env.RUNNER_BASH || "bash"; // overridable so tests can pin Git Bash on Windows
const GITHUB = /^https:\/\/github\.com\/[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
let hook = {};
let run = null; // { lines, stderr, done, exitCode }

const redact = (s) => (hook.OPENROUTER_API_KEY ? s.split(hook.OPENROUTER_API_KEY).join("***") : s);
const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

function pump(stream, sink) {
  let buf = "";
  stream.on("data", (c) => {
    buf += c;
    const parts = buf.split("\n");
    buf = parts.pop();
    for (const l of parts) sink.push(redact(l));
  });
  stream.on("end", () => { if (buf) sink.push(redact(buf)); });
}

function start(repoUrl, task) {
  run = { lines: [], stderr: [], done: false, exitCode: null };
  const child = spawn(BASH, [RUN_TASK_SCRIPT], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME || "/root",
      REPO_URL: repoUrl,
      TASK: task,
      MODEL: hook.MODEL || "deepseek/deepseek-v4.1-flash",
      OPENROUTER_API_KEY: hook.OPENROUTER_API_KEY,
      WORKDIR: "/workspace",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  pump(child.stdout, run.lines);
  pump(child.stderr, run.stderr);
  child.on("close", (code) => { run.exitCode = code; run.done = true; });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname.startsWith(HOOK)) {
      const raw = await readBody(req);
      if (url.pathname === HOOK + "run") {
        try { hook = JSON.parse(JSON.parse(raw || "{}").runHookPayload || "{}"); } catch { hook = {}; }
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok", started: !!run });
    if (req.method === "GET" && url.pathname === "/events") {
      if (!run) return send(res, 404, { error: "not started" });
      const since = Number(url.searchParams.get("since")) || 0;
      return send(res, 200, {
        lines: run.lines.slice(since),
        next: run.lines.length,
        done: run.done,
        exitCode: run.exitCode,
        stderrTail: run.done ? run.stderr.slice(-80) : [],
      });
    }
    if (req.method === "POST" && url.pathname === "/") {
      if (run) return send(res, 409, { error: "run already started" });
      let p;
      try { p = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "invalid JSON" }); }
      if (typeof p.repoUrl !== "string" || !GITHUB.test(p.repoUrl.replace(/\.git$/, ""))) return send(res, 400, { error: "invalid repoUrl" });
      if (typeof p.task !== "string" || !p.task) return send(res, 400, { error: "task required" });
      if (!hook.OPENROUTER_API_KEY) return send(res, 412, { error: "run hook payload not received" });
      start(p.repoUrl, p.task);
      return send(res, 202, { started: true });
    }
    send(res, 404, { error: "not found" });
  })
  .listen(PORT, () => console.log(`runner idle on ${PORT}`));
