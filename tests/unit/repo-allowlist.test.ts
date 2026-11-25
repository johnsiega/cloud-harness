// Which repos may receive a draft PR. Run: node --test tests/unit/repo-allowlist.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isAllowed, parseRepoList, repoSlug } from "../../api/repo-allowlist.ts";

const GOATS = "https://github.com/johnsiega/goats-hsw-rag-chatbot";
const LIST = parseRepoList("johnsiega/goats-hsw-rag-chatbot");

describe("repoSlug", () => {
  test("normalises the accepted URL forms to lowercase owner/repo", () => {
    assert.equal(repoSlug(GOATS), "johnsiega/goats-hsw-rag-chatbot");
    assert.equal(repoSlug(GOATS + ".git"), "johnsiega/goats-hsw-rag-chatbot");
    assert.equal(repoSlug("https://github.com/JohnSiega/Goats-HSW-RAG-Chatbot"), "johnsiega/goats-hsw-rag-chatbot");
    assert.equal(repoSlug("https://github.com/a/site.github.io"), "a/site.github.io");
  });
  test("anything that is not exactly https://github.com/<owner>/<repo> is null", () => {
    for (const u of ["http://github.com/a/b", "https://github.com.evil.com/a/b", "https://github.com@evil.com/a/b", "https://gitlab.com/a/b",
      `${GOATS}/tree/main`, `${GOATS}/`, "https://github.com/a", "github.com/a/b", "", "https://github.com/-a/b", 42 as unknown as string]) {
      assert.equal(repoSlug(u), null, String(u));
    }
  });
});

describe("parseRepoList", () => {
  test("splits, trims, lowercases and de-duplicates", () => {
    assert.deepEqual(parseRepoList(" JohnSiega/Goats-HSW-RAG-Chatbot , a/b,a/b ,"), ["johnsiega/goats-hsw-rag-chatbot", "a/b"]);
  });
  test("unset, empty and invalid entries give nothing (full URLs, spaces, extra slashes are dropped)", () => {
    assert.deepEqual(parseRepoList(undefined), []);
    assert.deepEqual(parseRepoList(""), []);
    assert.deepEqual(parseRepoList(`${GOATS},a b/c,a/b/c,owner/,/repo`), []);
  });
});

describe("isAllowed", () => {
  test("exact owner/repo match, case-insensitive, with or without .git", () => {
    assert.equal(isAllowed(GOATS, LIST), true);
    assert.equal(isAllowed("https://github.com/JOHNSIEGA/goats-hsw-rag-chatbot.git", LIST), true);
  });
  test("look-alikes are rejected", () => {
    for (const u of [`${GOATS}2`, `${GOATS}-fork`, "https://github.com/johnsiega/goats-hsw-rag", "https://github.com/someone/goats-hsw-rag-chatbot",
      "https://github.com/jyvnn/hospital-queue", `${GOATS}/tree/main`]) {
      assert.equal(isAllowed(u, LIST), false, u);
    }
  });
  test("an empty allowlist allows nothing", () => {
    assert.equal(isAllowed(GOATS, []), false);
  });
});
