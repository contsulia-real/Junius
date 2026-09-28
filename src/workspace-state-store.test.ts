import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";
import { WorkspaceStateStore } from "./workspace-state-store.js";

test(
  "WorkspaceStateStore round-trips root-only Workspace state",
  async () => {
    const directory =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-state-",
        ),
      );
    const filePath =
      join(
        directory,
        "workspace-state.json",
      );

    try {
      const manager =
        new WorkspaceManager([
          {
            id: "junius",
            profile:
              new WorkspaceProfile(
                "C:\\repo\\Junius",
              ),
          },
        ]);

      const store =
        new WorkspaceStateStore(
          filePath,
        );
      await store.save(
        manager,
      );

      assert.deepEqual(
        await store.load(),
        manager.list(),
      );

      const raw =
        JSON.parse(
          await readFile(
            filePath,
            "utf8",
          ),
        ) as {
          version: number;
          workspaces:
            unknown[];
        };
      assert.equal(
        raw.version,
        2,
      );
    } finally {
      await rm(
        directory,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);

test(
  "WorkspaceStateStore ignores legacy authorization fields while migrating state",
  async () => {
    const directory =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-state-legacy-",
        ),
      );
    const filePath =
      join(
        directory,
        "workspace-state.json",
      );

    try {
      await writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          workspaces: [
            {
              id: "legacy",
              rootPath:
                "C:\\legacy",
              grants: [
                {
                  key: "pnpm",
                  arguments: [
                    {
                      mode:
                        "exact",
                      args: [
                        "--version",
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
        "utf8",
      );

      const store =
        new WorkspaceStateStore(
          filePath,
        );
      assert.deepEqual(
        await store.load(),
        [
          {
            id: "legacy",
            rootPath:
              "C:\\legacy",
          },
        ],
      );
    } finally {
      await rm(
        directory,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);

test(
  "WorkspaceStateStore reports a missing state file as uninitialized",
  async () => {
    const directory =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-state-",
        ),
      );

    try {
      const store =
        new WorkspaceStateStore(
          join(
            directory,
            "missing.json",
          ),
        );
      assert.equal(
        await store.load(),
        undefined,
      );
    } finally {
      await rm(
        directory,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);
