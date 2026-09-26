import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";
import { WorkspaceStateStore } from "./workspace-state-store.js";

test("WorkspaceStateStore round-trips Workspace roots and grants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "junius-state-"));
  const filePath = join(directory, "workspace-state.json");

  try {
    const manager = new WorkspaceManager([
      {
        id: "junius",
        profile: new WorkspaceProfile("C:\\repo\\Junius", [
          {
            key: "pnpm",
            arguments: [
              { mode: "exact", args: ["--version"] },
              { mode: "prefix", args: ["run", "check"] },
            ],
          },
        ]),
      },
    ]);

    const store = new WorkspaceStateStore(filePath);
    await store.save(manager);

    assert.deepEqual(await store.load(), manager.list());

    const raw = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
    };
    assert.equal(raw.version, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("WorkspaceStateStore accepts the existing admin /state shape", async () => {
  const directory = await mkdtemp(join(tmpdir(), "junius-state-"));
  const filePath = join(directory, "workspace-state.json");

  try {
    await writeFile(
      filePath,
      JSON.stringify({
        registeredCapabilities: [
          { key: "pnpm", description: "ignored machine metadata" },
        ],
        workspaces: [
          {
            id: "weave",
            rootPath: "C:\\repo\\Weave",
            grants: [
              {
                key: "pnpm",
                arguments: [
                  { mode: "exact", args: ["run", "typecheck"] },
                ],
              },
            ],
          },
        ],
      }),
      "utf8",
    );

    const store = new WorkspaceStateStore(filePath);
    assert.deepEqual(await store.load(), [
      {
        id: "weave",
        rootPath: "C:\\repo\\Weave",
        grants: [
          {
            key: "pnpm",
            arguments: [
              { mode: "exact", args: ["run", "typecheck"] },
            ],
          },
        ],
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("WorkspaceStateStore reports a missing state file as uninitialized", async () => {
  const directory = await mkdtemp(join(tmpdir(), "junius-state-"));

  try {
    const store = new WorkspaceStateStore(
      join(directory, "missing.json"),
    );
    assert.equal(await store.load(), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("WorkspaceStateStore serializes overlapping saves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "junius-state-"));
  const filePath = join(directory, "workspace-state.json");

  try {
    const profile = new WorkspaceProfile("C:\\repo\\Junius", [
      {
        key: "pnpm",
        arguments: [{ mode: "exact", args: ["run", "check"] }],
      },
    ]);
    const manager = new WorkspaceManager([
      { id: "junius", profile },
    ]);
    const store = new WorkspaceStateStore(filePath);

    const firstSave = store.save(manager);

    profile.setGrant({
      key: "pnpm",
      arguments: [{ mode: "exact", args: ["run", "test"] }],
    });
    const secondSave = store.save(manager);

    await Promise.all([firstSave, secondSave]);

    assert.deepEqual(await store.load(), [
      {
        id: "junius",
        rootPath: "C:\\repo\\Junius",
        grants: [
          {
            key: "pnpm",
            arguments: [
              { mode: "exact", args: ["run", "test"] },
            ],
          },
        ],
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
