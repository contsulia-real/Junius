import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityRegistry } from "./capabilities/registry.js";
import type { Capability } from "./capabilities/types.js";
import { RunCommandService } from "./run-command.js";
import { WorkspaceProfile } from "./workspace-profile.js";

const fakeCapability: Capability = {
  key: "demo",
  description: "test capability",
  async execute(args) {
    return {
      ok: true,
      exitCode: 0,
      stdout: args.join(","),
      stderr: "",
      durationMs: 1,
    };
  },
};

test("run_command rejects unregistered capability keys", async () => {
  const service = new RunCommandService(
    new CapabilityRegistry(),
    new WorkspaceProfile(process.cwd()),
  );

  const result = await service.run("missing", []);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "capability_not_registered");
  }
});

test("run_command distinguishes missing capability grant from disallowed arguments", async () => {
  const registry = new CapabilityRegistry();
  registry.register(fakeCapability);

  const profile = new WorkspaceProfile(process.cwd());
  const service = new RunCommandService(registry, profile);

  const deniedCapability = await service.run("demo", ["a"]);
  assert.equal(deniedCapability.ok, false);
  if (!deniedCapability.ok) {
    assert.equal(deniedCapability.code, "capability_not_allowed");
  }

  profile.setGrant({
    key: "demo",
    arguments: [
      { mode: "exact", args: ["a"] },
      { mode: "prefix", args: ["run", "test"] },
    ],
  });

  const allowedExact = await service.run("demo", ["a"]);
  assert.equal(allowedExact.ok, true);

  const deniedArgs = await service.run("demo", ["b"]);
  assert.equal(deniedArgs.ok, false);
  if (!deniedArgs.ok) {
    assert.equal(deniedArgs.code, "arguments_not_allowed_by_workspace");
  }

  const allowedPrefix = await service.run("demo", [
    "run",
    "test",
    "--",
    "--watch=false",
  ]);
  assert.equal(allowedPrefix.ok, true);
});

test("revoking a Workspace grant disables the capability", async () => {
  const registry = new CapabilityRegistry();
  registry.register(fakeCapability);

  const profile = new WorkspaceProfile(process.cwd(), [
    {
      key: "demo",
      arguments: [{ mode: "exact", args: ["ok"] }],
    },
  ]);
  const service = new RunCommandService(registry, profile);

  assert.equal((await service.run("demo", ["ok"])).ok, true);

  profile.revoke("demo");

  const denied = await service.run("demo", ["ok"]);
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.code, "capability_not_allowed");
  }
});
