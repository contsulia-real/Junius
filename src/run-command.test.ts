import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityRegistry } from "./capabilities/registry.js";
import type { Capability } from "./capabilities/types.js";
import { RunCommandService } from "./run-command.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";

const fakeCapability: Capability = {
  key: "demo",
  description: "test capability",
  async execute(args, context) {
    return {
      ok: true,
      exitCode: 0,
      stdout: `${context.cwd}|${args.join(",")}`,
      stderr: "",
      durationMs: 1,
    };
  },
};

test("run_command rejects unknown Workspace IDs", async () => {
  const registry = new CapabilityRegistry();
  registry.register(fakeCapability);

  const service = new RunCommandService(
    registry,
    new WorkspaceManager(),
  );

  const result = await service.run("missing", "demo", []);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "workspace_not_registered");
  }
});

test("run_command rejects unregistered capability keys", async () => {
  const profile = new WorkspaceProfile(process.cwd());
  const service = new RunCommandService(
    new CapabilityRegistry(),
    new WorkspaceManager([{ id: "alpha", profile }]),
  );

  const result = await service.run("alpha", "missing", []);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "capability_not_registered");
  }
});

test("run_command enforces grants independently per Workspace", async () => {
  const registry = new CapabilityRegistry();
  registry.register(fakeCapability);

  const alpha = new WorkspaceProfile("C:\\alpha", [
    {
      key: "demo",
      arguments: [{ mode: "exact", args: ["a"] }],
    },
  ]);
  const beta = new WorkspaceProfile("C:\\beta", [
    {
      key: "demo",
      arguments: [{ mode: "exact", args: ["b"] }],
    },
  ]);

  const service = new RunCommandService(
    registry,
    new WorkspaceManager([
      { id: "alpha", profile: alpha },
      { id: "beta", profile: beta },
    ]),
  );

  const alphaAllowed = await service.run("alpha", "demo", ["a"]);
  const alphaDenied = await service.run("alpha", "demo", ["b"]);
  const betaAllowed = await service.run("beta", "demo", ["b"]);
  const betaDenied = await service.run("beta", "demo", ["a"]);

  assert.equal(alphaAllowed.ok, true);
  assert.equal(betaAllowed.ok, true);
  assert.equal(alphaDenied.ok, false);
  assert.equal(betaDenied.ok, false);

  if (alphaAllowed.ok) {
    assert.equal(alphaAllowed.execution.stdout, "C:\\alpha|a");
  }

  if (betaAllowed.ok) {
    assert.equal(betaAllowed.execution.stdout, "C:\\beta|b");
  }

  if (!alphaDenied.ok) {
    assert.equal(
      alphaDenied.code,
      "arguments_not_allowed_by_workspace",
    );
  }

  if (!betaDenied.ok) {
    assert.equal(
      betaDenied.code,
      "arguments_not_allowed_by_workspace",
    );
  }
});


test("run_command exposes Workspace catalog", () => {
  const manager = new WorkspaceManager([
    {
      id: "alpha",
      profile: new WorkspaceProfile("C:\\alpha", [
        {
          key: "demo",
          arguments: [{ mode: "exact", args: ["a"] }],
        },
      ]),
    },
    {
      id: "beta",
      profile: new WorkspaceProfile("C:\\beta"),
    },
  ]);

  const service = new RunCommandService(
    new CapabilityRegistry(),
    manager,
  );

  assert.deepEqual(service.listWorkspaces(), [
    {
      id: "alpha",
      rootPath: "C:\\alpha",
      grants: [
        {
          key: "demo",
          arguments: [{ mode: "exact", args: ["a"] }],
        },
      ],
    },
    {
      id: "beta",
      rootPath: "C:\\beta",
      grants: [],
    },
  ]);
});
