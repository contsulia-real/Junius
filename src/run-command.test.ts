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

test("run_command enforces Workspace Profile authorization", async () => {
  const registry = new CapabilityRegistry();
  registry.register(fakeCapability);

  const profile = new WorkspaceProfile(process.cwd());
  const service = new RunCommandService(registry, profile);

  const denied = await service.run("demo", []);
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.code, "capability_not_allowed");
  }

  profile.allow("demo");

  const allowed = await service.run("demo", ["a", "b"]);
  assert.equal(allowed.ok, true);
  if (allowed.ok) {
    assert.equal(allowed.execution.stdout, "a,b");
  }
});
