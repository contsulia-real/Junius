import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedPnpmArgs } from "./pnpm-capability.js";

test("pnpm capability allows version and package scripts", () => {
  assert.equal(isAllowedPnpmArgs(["--version"]), true);
  assert.equal(isAllowedPnpmArgs(["run", "check"]), true);
  assert.equal(isAllowedPnpmArgs(["run", "test:unit"]), true);
  assert.equal(
    isAllowedPnpmArgs(["run", "test", "--", "--test-name-pattern", "demo"]),
    true,
  );
});

test("pnpm capability does not expose package-management or arbitrary execution commands", () => {
  for (const args of [
    ["install"],
    ["add", "left-pad"],
    ["exec", "powershell"],
    ["dlx", "some-package"],
    ["run"],
    ["run", "../bad"],
  ]) {
    assert.equal(isAllowedPnpmArgs(args), false, args.join(" "));
  }
});
