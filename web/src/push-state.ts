// Pure UI state for the push button: when it shows, what each outcome looks like, what the user is told on failure.
import type { RunView } from "./run-view.ts";

export type PushStatus = "idle" | "pushing" | "pushed" | "failed";
export type PushState = { status: PushStatus; branch?: string; commit?: string; url?: string; error?: string };
export type PushConfig = { pushEnabled: boolean; pushTarget?: string };
export type PushAction =
  | { type: "start" }
  | { type: "success"; branch: string; commit: string; url: string }
  | { type: "failure"; status: number; body: { error?: string; reason?: string; branch?: string; url?: string } };

export function initialPush(): PushState {
  return { status: "idle" };
}

export function reducePush(state: PushState, action: PushAction): PushState {
  switch (action.type) {
    case "start":
      // Ignored while pushing or once pushed, so a double click can never submit twice.
      return state.status === "idle" || state.status === "failed" ? { status: "pushing" } : state;
    case "success":
      return { status: "pushed", branch: action.branch, commit: action.commit, url: action.url };
    case "failure":
      if (state.status === "pushed") return state; // a late failure must not hide a push that happened
      // 409 naming a branch means this run was already pushed: show where, not an error.
      if (action.status === 409 && action.body.branch) return { status: "pushed", branch: action.body.branch, url: action.body.url };
      return { status: "failed", error: pushErrorMessage(action.status, action.body) };
  }
}

export function canPush(view: RunView, cfg: PushConfig | undefined, runId: string | undefined): boolean {
  return !!cfg?.pushEnabled && !!runId && view.phase === "done" && !!view.diff?.trim();
}

const TOKEN_SHAPES = /(?:sk-or-|github_pat_|ghp_)[A-Za-z0-9_-]+/g;

export function pushErrorMessage(status: number, body: { error?: string; reason?: string }): string {
  if (status === 0) return "Can't reach the control plane.";
  if (status === 503) return "Push isn't set up. Add GIT_PUSH_TOKEN to .env and restart the control plane.";
  switch (body.reason) {
    case "branch_exists": return "A branch for this run already exists in the target repo.";
    case "stale_base": return "The source repo changed, so the commit this run started from is no longer available.";
    case "patch_failed": return "The patch no longer applies cleanly to the commit the run started from.";
    case "redacted_diff": return "The diff contained a secret that was redacted, so it can't be pushed unchanged.";
    case "push_failed": return "GitHub rejected the push. Check that the token has Contents read and write access to the target repo.";
  }
  return body.error ? body.error.replace(TOKEN_SHAPES, "[REDACTED]") : `Push failed (${status}).`;
}

export function pushLabel(state: PushState): string {
  return { idle: "Push to branch", pushing: "Pushing", pushed: "Pushed", failed: "Try push again" }[state.status];
}

export function shortSha(sha: string | undefined): string {
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : "";
}
