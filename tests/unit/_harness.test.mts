import assert from "node:assert/strict";
import { describe, test } from "node:test";

describe("test harness", () => {
  test("node:test runs through tsx", () => {
    assert.equal(1 + 1, 2);
  });

  test("node:assert/strict catches mismatches", () => {
    assert.throws(() => assert.equal(1, 2));
  });
});
