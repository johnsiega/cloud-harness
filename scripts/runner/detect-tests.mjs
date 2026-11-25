// Decides how to test a freshly cloned repo inside the VM. First match wins: PHP, Node, Python, otherwise none.
// CLI: `node detect-tests.mjs <dir>` prints three lines for run-task.sh: install command (may be empty), test command, skip reason.
// Every value is one of the fixed strings below (no newlines), so the line protocol is safe. The user's own command never comes here.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const has = (dir, f) => existsSync(join(dir, f));
const read = (dir, f) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } };

function hasNodeTests(dir) {
  try {
    const t = JSON.parse(read(dir, "package.json"))?.scripts?.test;
    return typeof t === "string" && t.trim() !== "" && !t.includes("Error: no test specified"); // npm init's placeholder
  } catch { return false; } // missing or malformed package.json: not a Node test suite
}

function hasPytest(dir) {
  if (has(dir, "pytest.ini") || has(dir, "conftest.py") || read(dir, "pyproject.toml").includes("[tool.pytest")) return true;
  try { return readdirSync(join(dir, "tests")).some((f) => /^test_.*\.py$/.test(f)); } catch { return false; }
}

export function detectTests(dir) {
  if (has(dir, "composer.json")) {
    return { install: "", test: has(dir, "artisan") ? "composer install --no-interaction && php artisan test" : "composer install --no-interaction && vendor/bin/phpunit" };
  }
  if (hasNodeTests(dir)) return { install: "npm ci || npm install", test: "npm test" };
  if (hasPytest(dir)) return { install: has(dir, "requirements.txt") ? "python3 -m pip install -q -r requirements.txt" : "", test: "python3 -m pytest -q" };
  return { skip: "no tests found" };
}

export function formatPlan(p) {
  return "skip" in p ? `\n\n${p.skip}\n` : `${p.install}\n${p.test}\n\n`;
}

// Same guard style as scripts/smoke-test.ts (a filename match works from any folder on every OS).
if (process.argv[1] && /detect-tests\.mjs$/.test(process.argv[1].replace(/\\/g, "/"))) {
  if (!process.argv[2]) { console.error("usage: node detect-tests.mjs <repo-dir>"); process.exit(2); }
  process.stdout.write(formatPlan(detectTests(process.argv[2])));
}
