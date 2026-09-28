import assert from "node:assert/strict";
import test from "node:test";
import {
  playwrightCliCommandArgs,
  validatePlaywrightCliArgs,
} from "./playwright-cli-policy.js";

test("playwright-cli policy accepts snapshot element refs and rejects selectors", () => {
  assert.equal(
    validatePlaywrightCliArgs("click", ["e12"]),
    true,
  );
  assert.equal(
    validatePlaywrightCliArgs("click", ["f1e12"]),
    true,
  );
  assert.equal(
    validatePlaywrightCliArgs("fill", ["e7", "hello"]),
    true,
  );
  assert.equal(
    validatePlaywrightCliArgs("fill", ["f23e7", "hello"]),
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
  assert.equal(
    validatePlaywrightCliArgs("click", ["f1f2e12"]),
    false,
  );
  assert.equal(
    validatePlaywrightCliArgs("click", ["frame-e12"]),
    false,
  );
});

test("playwright-cli fill protects leading-dash text from CLI option parsing", () => {
  assert.deepEqual(
    playwrightCliCommandArgs(
      "browser",
      "fill",
      ["e7", "--version"],
    ),
    [
      "-s=browser",
      "fill",
      "e7",
      "--",
      "--version",
    ],
  );

  assert.deepEqual(
    playwrightCliCommandArgs(
      "browser",
      "fill",
      ["e7", "--version", "--submit"],
    ),
    [
      "-s=browser",
      "fill",
      "e7",
      "--submit",
      "--",
      "--version",
    ],
  );
});
