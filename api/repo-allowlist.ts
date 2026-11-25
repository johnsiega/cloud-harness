// Which repos may receive a draft PR (PR_REPOS). Exact owner/repo, case-insensitive. Shared by the server and the UI.
const SLUG = /^[a-z0-9][\w.-]*\/[\w.-]+$/;
const REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9][\w.-]*\/[\w.-]+?)(?:\.git)?$/;

export function repoSlug(url: string): string | null {
  const m = typeof url === "string" ? REPO_URL.exec(url) : null;
  return m ? m[1].toLowerCase() : null;
}

export function parseRepoList(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => SLUG.test(s)))];
}

export function isAllowed(url: string, repos: readonly string[]): boolean {
  const s = repoSlug(url);
  return s !== null && repos.includes(s);
}
