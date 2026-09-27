import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";

test("WorkspaceManager keeps independent profiles addressable in parallel", async () => {
  const firstRaw = await mkdtemp(join(tmpdir(), "junius-workspaces-"));
  const secondRaw = await mkdtemp(join(tmpdir(), "junius-workspaces-"));
  const first = await realpath(firstRaw);
  const second = await realpath(secondRaw);

  try {
    const firstProfile = new WorkspaceProfile(first, [
      {
        key: "pnpm",
        arguments: [{ mode: "exact", args: ["run", "check"] }],
      },
    ]);

    const manager = new WorkspaceManager([
      { id: "alpha", profile: firstProfile },
    ]);

    const secondProfile = await manager.register("beta", second);
    secondProfile.setGrant({
      key: "pnpm",
      arguments: [{ mode: "exact", args: ["run", "build"] }],
    });

    assert.equal(
      manager.get("alpha")?.isInvocationAllowed(
        "pnpm",
        ["run", "check"],
      ),
      true,
    );
    assert.equal(
      manager.get("alpha")?.isInvocationAllowed(
        "pnpm",
        ["run", "build"],
      ),
      false,
    );
    assert.equal(
      manager.get("beta")?.isInvocationAllowed(
        "pnpm",
        ["run", "build"],
      ),
      true,
    );
    assert.equal(
      manager.get("beta")?.isInvocationAllowed(
        "pnpm",
        ["run", "check"],
      ),
      false,
    );

    assert.deepEqual(
      manager.list().map((workspace) => workspace.id),
      ["alpha", "beta"],
    );
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("WorkspaceManager atomically replaces persisted Workspace state", async () => {
  const firstRaw = await mkdtemp(join(tmpdir(), "junius-workspaces-"));
  const secondRaw = await mkdtemp(join(tmpdir(), "junius-workspaces-"));
  const first = await realpath(firstRaw);
  const second = await realpath(secondRaw);

  try {
    const manager = new WorkspaceManager([
      {
        id: "alpha",
        profile: new WorkspaceProfile(first, [
          {
            key: "pnpm",
            arguments: [
              { mode: "exact", args: ["run", "check"] },
            ],
          },
        ]),
      },
    ]);

    manager.replace([
      {
        id: "beta",
        rootPath: second,
        grants: [
          {
            key: "pnpm",
            arguments: [
              { mode: "exact", args: ["run", "build"] },
            ],
          },
        ],
      },
    ]);

    assert.equal(manager.has("alpha"), false);
    assert.equal(
      manager.get("beta")?.isInvocationAllowed(
        "pnpm",
        ["run", "build"],
      ),
      true,
    );

    assert.throws(
      () =>
        manager.replace([
          { id: "first", rootPath: first, grants: [] },
          { id: "second", rootPath: first, grants: [] },
        ]),
      /workspace_root_already_registered/u,
    );
    assert.equal(manager.has("beta"), true);
    assert.equal(manager.has("first"), false);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("WorkspaceManager rejects duplicate IDs and duplicate roots", async () => {
  const rootRaw = await mkdtemp(join(tmpdir(), "junius-workspaces-"));
  const root = await realpath(rootRaw);

  try {
    const manager = new WorkspaceManager([
      {
        id: "alpha",
        profile: new WorkspaceProfile(root),
      },
    ]);

    await assert.rejects(
      manager.register("alpha", root),
      /workspace_id_already_registered/u,
    );

    await assert.rejects(
      manager.register("beta", root),
      /workspace_root_already_registered/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
