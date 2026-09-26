import assert from "node:assert/strict";
import test from "node:test";
import { ProcessCapability } from "./process-capability.js";

test("ProcessCapability uses shell:false execution with allowed arguments", async () => {
  const capability = new ProcessCapability({
    key: "node",
    description: "test node",
    executable: process.execPath,
    allowedArgVectors: [["--version"]],
    timeoutMs: 5_000,
  });

  const result = await capability.execute(["--version"], {
    cwd: process.cwd(),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.stdout.trim(), /^v\d+\./);
  }
});

test("ProcessCapability rejects arguments outside its policy", async () => {
  const capability = new ProcessCapability({
    key: "node",
    description: "test node",
    executable: process.execPath,
    allowedArgVectors: [["--version"]],
  });

  const result = await capability.execute(
    ["-e", "console.log('should not run')"],
    { cwd: process.cwd() },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "arguments_not_allowed");
  }
});


test("ProcessCapability supports fixed launcher args and predicate policy", async () => {
  const capability = new ProcessCapability({
    key: "node-expression",
    description: "test fixed args",
    executable: process.execPath,
    fixedArgs: ["-p"],
    argumentPolicy: (args) =>
      args.length === 1 && args[0] === "process.platform",
    timeoutMs: 5_000,
  });

  const result = await capability.execute(["process.platform"], {
    cwd: process.cwd(),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.stdout.trim(), process.platform);
  }
});
