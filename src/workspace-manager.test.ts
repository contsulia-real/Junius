import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";

test("WorkspaceManager registers and switches independent profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "junius-workspaces-"));
  const first = await realpath(root);
  const secondRaw = await mkdtemp(join(tmpdir(), "junius-workspaces-"));
  const second = await realpath(secondRaw);

  try {
    const firstProfile = new WorkspaceProfile(first, [
      {
        key: "pnpm",
        arguments: [{ mode: "exact", args: ["run", "check"] }],
      },
    ]);
    const manager = new WorkspaceManager(firstProfile);

    assert.equal(manager.activeProfile().rootPath, first);

    const secondProfile = await manager.register(second);
    secondProfile.setGrant({
      key: "pnpm",
      arguments: [{ mode: "exact", args: ["run", "build"] }],
    });

    const activated = await manager.activate(second);
    assert.ok(activated);
    assert.equal(manager.activeProfile().rootPath, second);
    assert.equal(
      manager.activeProfile().isInvocationAllowed(
        "pnpm",
        ["run", "build"],
      ),
      true,
    );
    assert.equal(
      manager.activeProfile().isInvocationAllowed(
        "pnpm",
        ["run", "check"],
      ),
      false,
    );

    const states = manager.list();
    assert.equal(states.length, 2);
    assert.equal(states.filter((state) => state.active).length, 1);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});
