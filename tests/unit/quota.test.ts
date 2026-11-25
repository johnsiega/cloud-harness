// Quota detection shared by scripts/load-real.ts and scripts/measure-startup.ts. Run: node --test tests/unit/quota.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isQuotaError } from "../../api/quota.ts";

// The text AWS actually returned when a fifth 2 GB MicroVM was refused (2026-11-25, docs/measurements/load-real.json).
const AWS_REFUSAL = "The base maximum allocated memory limit has been reached for this account.";

describe("isQuotaError", () => {
  test("recognises the message AWS really returned, which does not contain the word 'quota'", () => {
    assert.equal(isQuotaError(AWS_REFUSAL), true);
  });

  test("recognises the word quota in any case, including the exception name", () => {
    for (const s of ["memory quota reached", "ServiceQuotaExceededException: Rate exceeded", "Quota exceeded", "QUOTA"]) {
      assert.equal(isQuotaError(s), true, s);
    }
  });

  test("recognises the AWS wording inside a longer line, in any case", () => {
    assert.equal(isQuotaError(`Error: ${AWS_REFUSAL} Request ID 123`), true);
    assert.equal(isQuotaError(AWS_REFUSAL.toUpperCase()), true);
  });

  test("does not call ordinary failures a quota problem", () => {
    for (const s of ["tests failed", "events poll failed: HTTP 502", "request to the sandbox timed out after 30000 ms", "sandbox not ready after 300000 ms", "memory allocation failed in the test suite", "", undefined]) {
      assert.equal(isQuotaError(s), false, String(s));
    }
  });
});
