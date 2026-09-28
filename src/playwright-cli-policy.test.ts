import assert from "node:assert/strict";
import test from "node:test";
import { validatePlaywrightCliArgs } from "./playwright-cli-policy.js";

test("playwright-cli policy accepts snapshot element refs and rejects selectors", () => {
  assert.equal(
    validatePlaywrightCliArgs("click", ["e12"]),
    true,
  );
  assert.equal(
    validatePlaywrightCliArgs("fill", ["e7", "hello"]),
    true,
  );
  assert.equal(
    validatePlaywrightCliArgs("snapshot", ["e3"]),
    true,
  );
  assert.equal(
    validatePlaywrightCliArgs("click", ["#selector"]),
    false,
  );
});
