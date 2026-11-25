// Detection on fake repos in temp folders. No network, no git. Run: node --test scripts/runner/detect-tests.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { detectTests, formatPlan } from "./detect-tests.mjs";

const CLI = join(import.meta.dirname, "detect-tests.mjs");
const LARAVEL = "composer install --no-interaction && php artisan test"; // today's hardcoded command, hand-copied
const PHPUNIT = "composer install --no-interaction && vendor/bin/phpunit";
const NODE = { install: "npm ci || npm install", test: "npm test" };
const PYTEST = "python3 -m pytest -q";
const PIP = "python3 -m pip install -q -r requirements.txt";
const NONE = { skip: "no tests found" };
const PKG = (test?: unknown) => JSON.stringify(test === undefined ? { name: "x" } : { name: "x", scripts: { test } });

function repo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "detect-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), body);
  }
  return d;
}

describe("detectTests: PHP", () => {
  test("composer.json + artisan gives exactly today's Laravel command, with no separate install", () => {
    assert.deepEqual(detectTests(repo({ "composer.json": "{}", artisan: "<?php" })), { install: "", test: LARAVEL });
  });
  test("composer.json without artisan runs phpunit", () => {
    assert.deepEqual(detectTests(repo({ "composer.json": "{}" })), { install: "", test: PHPUNIT });
  });
  test("regression: the hospital-queue root (composer.json, artisan, package.json with a test script, tests/) is PHP", () => {
    const d = repo({ "composer.json": "{}", artisan: "<?php", "package.json": PKG("vitest"), "tests/Feature/ExampleTest.php": "<?php", "phpunit.xml": "<x/>" });
    assert.deepEqual(detectTests(d), { install: "", test: LARAVEL });
  });
});

describe("detectTests: Node", () => {
  test("a real test script gives npm ci || npm install, then npm test", () => {
    assert.deepEqual(detectTests(repo({ "package.json": PKG("node --test") })), NODE);
  });
  test("npm's placeholder test script is not a test suite", () => {
    assert.deepEqual(detectTests(repo({ "package.json": PKG('echo "Error: no test specified" && exit 1') })), NONE);
  });
  test("no scripts, an empty script, or a non-string script is not a test suite", () => {
    for (const p of [PKG(), PKG(""), PKG("   "), PKG(42), JSON.stringify({ scripts: null }), "null"]) {
      assert.deepEqual(detectTests(repo({ "package.json": p })), NONE, p);
    }
  });
  test("a malformed package.json is skipped over, not fatal: detection falls through to Python, then to none", () => {
    assert.deepEqual(detectTests(repo({ "package.json": "{not json" })), NONE);
    assert.deepEqual(detectTests(repo({ "package.json": "{not json", "pytest.ini": "[pytest]" })), { install: "", test: PYTEST });
  });
});

describe("detectTests: Python (pytest evidence)", () => {
  for (const [name, files] of [
    ["pytest.ini", { "pytest.ini": "[pytest]" }],
    ["[tool.pytest in pyproject.toml", { "pyproject.toml": "[project]\nname='x'\n[tool.pytest.ini_options]\naddopts='-q'\n" }],
    ["conftest.py", { "conftest.py": "" }],
    ["tests/test_*.py", { "tests/test_app.py": "def test_x(): pass" }],
  ] as const) {
    test(`${name} is evidence; without requirements.txt there is no install`, () => {
      assert.deepEqual(detectTests(repo(files)), { install: "", test: PYTEST });
    });
  }
  test("requirements.txt adds a pip install of it", () => {
    assert.deepEqual(detectTests(repo({ "conftest.py": "", "requirements.txt": "requests\n" })), { install: PIP, test: PYTEST });
  });
  test("not evidence: pyproject.toml without [tool.pytest, tests/ without test_*.py, test files outside tests/", () => {
    assert.deepEqual(detectTests(repo({ "pyproject.toml": "[project]\nname='x'\n" })), NONE);
    assert.deepEqual(detectTests(repo({ "tests/helpers.py": "" })), NONE);
    assert.deepEqual(detectTests(repo({ "tests/sub/test_deep.py": "" })), NONE); // D5: direct children only
  });
  test("the goats-hsw-rag-chatbot shape (app.py, requirements.txt, verification/test_fallback.py) is 'no tests found'", () => {
    const d = repo({ "app.py": "", "requirements.txt": "gradio\n", Dockerfile: "FROM x", "verification/test_fallback.py": "", "verification/ui_test.py": "" });
    assert.deepEqual(detectTests(d), NONE);
  });
});

describe("detectTests: priority and no match", () => {
  test("first match wins: PHP over Node, Node over Python", () => {
    assert.deepEqual(detectTests(repo({ "composer.json": "{}", "package.json": PKG("jest"), "pytest.ini": "" })), { install: "", test: PHPUNIT });
    assert.deepEqual(detectTests(repo({ "package.json": PKG("jest"), "pytest.ini": "" })), NODE);
  });
  test("an empty repo, and a folder that does not exist, give 'no tests found'", () => {
    assert.deepEqual(detectTests(repo({})), NONE);
    assert.deepEqual(detectTests(join(tmpdir(), "does-not-exist-" + Date.now())), NONE);
  });
});

describe("formatPlan and the CLI", () => {
  test("formatPlan prints exactly three lines: install, test, skip reason", () => {
    assert.equal(formatPlan({ install: PIP, test: PYTEST }), `${PIP}\n${PYTEST}\n\n`);
    assert.equal(formatPlan({ install: "", test: LARAVEL }), `\n${LARAVEL}\n\n`);
    assert.equal(formatPlan(NONE), "\n\nno tests found\n");
  });
  test("no detected value ever contains a newline (the line protocol depends on it)", () => {
    for (const files of [{ "composer.json": "{}", artisan: "" }, { "composer.json": "{}" }, { "package.json": PKG("x") }, { "conftest.py": "", "requirements.txt": "" }, {}]) {
      const out = formatPlan(detectTests(repo(files)));
      assert.equal(out.split("\n").length, 4, JSON.stringify(out)); // three lines + the final empty piece
    }
  });
  test("the CLI prints formatPlan(detectTests(dir)) and exits 0", () => {
    const d = repo({ "package.json": PKG("node --test") });
    const r = spawnSync(process.execPath, [CLI, d], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "npm ci || npm install\nnpm test\n\n"); // literal, so it cannot pass against an empty formatPlan
  });
  test("the CLI without a directory argument exits non-zero and prints nothing on stdout", () => {
    const r = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
  });
});
