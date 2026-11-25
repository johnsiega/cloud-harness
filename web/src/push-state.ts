// Pure UI state for the push button: when it shows, what each outcome looks like, what the user is told on failure.
import { isAllowed } from "../../api/repo-allowlist.ts";
import type { RunView } from "./run-view.ts";

export type PushStatus = "idle" | "pushing" | "pushed" | "failed";
export type PushMode = "pr" | "branch";
export type PushState = { status: PushStatus; branch?: string; commit?: string; url?: string; error?: string; number?: number };
export type PushConfig = { pushEnabled: boolean; pushTarget?: string; prRepos?: string[] };
export type PushAction =
  | { type: "start" }
  | { type: "success"; branch: string; commit?: string; url: string; number?: number }
  | { type: "failure"; status: number; mode?: PushMode; body: { error?: string; reason?: string; branch?: string; url?: string; number?: number } };

export function initialPush(): PushState {
  return { status: "idle" };
}

export function reducePush(state: PushState, action: PushAction): PushState {
  switch (action.type) {
    case "start":
      // Ignored while pushing or once pushed, so a double click can never submit twice.
      return state.status === "idle" || state.status === "failed" ? { status: "pushing" } : state;
    case "success":
      // Optional fields are left out (not set to undefined): a branch push has no PR number and a PR has no commit to show.
      return { status: "pushed", branch: action.branch, ...(action.commit ? { commit: action.commit } : {}), url: action.url, ...(action.number ? { number: action.number } : {}) };
    case "failure":
      if (state.status === "pushed") return state; // a late failure must not hide a push that happened
      // 409 naming a branch means this run was already pushed: show where, not an error.
      if (action.status === 409 && action.body.branch) return { status: "pushed", branch: action.body.branch, url: action.body.url, ...(action.body.number ? { number: action.body.number } : {}) };
      return { status: "failed", error: pushErrorMessage(action.status, action.body, action.mode) };
  }
}

export function canPush(view: RunView, cfg: PushConfig | undefined, runId: string | undefined): boolean {
  return !!cfg?.pushEnabled && !!runId && view.phase === "done" && !!view.diff?.trim();
}

// Which button the diff panel shows: a draft PR for allowlisted repos (even if the staging push is off), otherwise v1's push to the staging repo.
export function pushMode(view: RunView, cfg: PushConfig | undefined, runId: string | undefined, repoUrl: string | undefined): PushMode | null {
  if (!runId || view.phase !== "done" || !view.diff?.trim()) return null;
  if (repoUrl && cfg?.prRepos && isAllowed(repoUrl, cfg.prRepos)) return "pr";
  return canPush(view, cfg, runId) ? "branch" : null;
}

const TOKEN_SHAPES = /(?:sk-or-|github_pat_|ghp_)[A-Za-z0-9_-]+/g;

export function pushErrorMessage(status: number, body: { error?: string; reason?: string }, mode: PushMode = "branch"): string {
  if (status === 0) return "Can't reach the control plane.";
  if (status === 503) return mode === "pr" ? "Draft PRs aren't set up. Add PR_REPOS and GIT_PR_TOKEN to .env and restart the control plane." : "Push isn't set up. Add GIT_PUSH_TOKEN to .env and restart the control plane.";
  switch (body.reason) {
    case "branch_exists": return "A branch for this run already exists in the target repo.";
    case "stale_base": return "The source repo changed, so the commit this run started from is no longer available.";
    case "patch_failed": return "The patch no longer applies cleanly to the commit the run started from.";
    case "redacted_diff": return "The diff contained a secret that was redacted, so it can't be pushed unchanged.";
    case "push_failed": return "GitHub rejected the push. Check that the token has Contents read and write access to the target repo.";
  }
  return body.error ? body.error.replace(TOKEN_SHAPES, "[REDACTED]") : `Push failed (${status}).`;
}

export function pushLabel(state: PushState, mode: PushMode = "branch"): string {
  const labels = mode === "pr"
    ? { idle: "Open draft PR", pushing: "Opening draft PR", pushed: "Draft PR opened", failed: "Try again" }
    : { idle: "Push to branch", pushing: "Pushing", pushed: "Pushed", failed: "Try push again" };
  return labels[state.status];
}

export function shortSha(sha: string | undefined): string {
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : "";
}
