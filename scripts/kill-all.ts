// Emergency stop: terminate every MicroVM in the account and Region (optionally only one image's). DRY RUN by default.
//   AWS_PROFILE=<your-profile> node scripts/kill-all.ts            lists what would be terminated, changes nothing
//   AWS_PROFILE=<your-profile> node scripts/kill-all.ts --yes      terminates them (paced under the 10/s TerminateMicrovm limit)
import { createAwsMicrovms } from "../api/aws-microvms.ts";
import type { AwsMicrovms } from "../api/types.ts";

export type Vm = { microvmId: string; state: string };
export type KillDeps = { aws: Pick<AwsMicrovms, "list" | "terminate">; sleep: (ms: number) => Promise<void> };
export type KillOpts = { yes: boolean; imageArn?: string; paceMs?: number; maxAttempts?: number };
export type KillResult = { dryRun: boolean; planned: Vm[]; terminated: string[]; failed: { microvmId: string; error: string }[] };

const GONE = new Set(["TERMINATED", "TERMINATING"]);

export function planKill(vms: Vm[]): Vm[] {
  return vms.filter((v) => !GONE.has(v.state.toUpperCase()));
}

export async function killAll(deps: KillDeps, opts: KillOpts): Promise<KillResult> {
  const planned = planKill(await deps.aws.list(opts.imageArn));
  const result: KillResult = { dryRun: !opts.yes, planned, terminated: [], failed: [] };
  if (!opts.yes) return result;

  const paceMs = opts.paceMs ?? 200; // 5 per second at most, half the documented 10/s TerminateMicrovm limit
  const maxAttempts = opts.maxAttempts ?? 5;
  for (const [i, vm] of planned.entries()) {
    if (i > 0) await deps.sleep(paceMs);
    try {
      await terminateWithRetry(deps, vm.microvmId, maxAttempts);
      result.terminated.push(vm.microvmId);
    } catch (e) {
      result.failed.push({ microvmId: vm.microvmId, error: e instanceof Error ? e.message : String(e) }); // keep going: one bad VM must not strand the rest
    }
  }
  return result;
}

async function terminateWithRetry(deps: KillDeps, id: string, maxAttempts: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.aws.terminate(id);
      return;
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "ResourceNotFoundException") return; // already gone: that is the goal
      if (name !== "ThrottlingException" || attempt >= maxAttempts) throw e;
      await deps.sleep(500 * 2 ** (attempt - 1));
    }
  }
}

export function exitCodeFor(result: KillResult): 0 | 1 {
  return result.failed.length > 0 ? 1 : 0;
}

export function formatReport(result: KillResult, opts: { imageArn?: string }): string {
  if (result.dryRun) {
    if (result.planned.length === 0) return "No MicroVMs to terminate.";
    return [
      `Dry run: ${result.planned.length} MicroVM(s) would be terminated. Nothing was changed.`,
      ...result.planned.map((v) => `  ${v.microvmId}  ${v.state}`),
      "",
      `To terminate them, run (same AWS_PROFILE): node scripts/kill-all.ts --yes${opts.imageArn ? ` --image ${opts.imageArn}` : ""}`,
    ].join("\n");
  }
  if (result.terminated.length + result.failed.length === 0) return "No MicroVMs to terminate.";
  return [
    `Terminated ${result.terminated.length}, failed ${result.failed.length}.`,
    ...result.failed.map((f) => `  ${f.microvmId}: ${f.error}`),
  ].join("\n");
}

export function parseArgs(argv: string[]): { yes: boolean; imageArn?: string } {
  const out: { yes: boolean; imageArn?: string } = { yes: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--yes") out.yes = true;
    else if (argv[i] === "--image") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error("--image needs an image ARN. Usage: node scripts/kill-all.ts [--yes] [--image <arn>]");
      out.imageArn = v;
    } else throw new Error(`unknown argument "${argv[i]}". Usage: node scripts/kill-all.ts [--yes] [--image <arn>]`);
  }
  return out;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const aws = createAwsMicrovms({ region: process.env.AWS_REGION ?? "us-east-1" });
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const result = await killAll({ aws, sleep }, opts);
  console.log(formatReport(result, opts));
  return exitCodeFor(result);
}

if (process.argv[1] && /kill-all\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().then((code) => process.exit(code), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(2); });
}
