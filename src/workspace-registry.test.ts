import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceRegistryService } from "./workspace-registry.js";
import { WorkspaceStateStore } from "./workspace-state-store.js";

test(
  "WorkspaceRegistryService creates and deletes persistent registrations without deleting directories",
  async () => {
    const stateRoot =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-workspace-registry-",
        ),
      );
    const projectRoot =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-workspace-project-",
        ),
      );
    const statePath =
      join(
        stateRoot,
        "workspace-state.json",
      );

    try {
      const manager =
        new WorkspaceManager();
      const service =
        new WorkspaceRegistryService(
          manager,
          new WorkspaceStateStore(
            statePath,
          ),
        );

      const created =
        await service.create(
          "project",
          projectRoot,
        );

      assert.equal(
        created.id,
        "project",
      );
      assert.equal(
        manager.has(
          "project",
        ),
        true,
      );

      const persistedAfterCreate =
        JSON.parse(
          await readFile(
            statePath,
            "utf8",
          ),
        ) as {
          workspaces:
            {
              id: string;
            }[];
        };
      assert.equal(
        persistedAfterCreate
          .workspaces[0]?.id,
        "project",
      );

      const deleted =
        await service.delete(
          "project",
        );
      assert.equal(
        deleted.id,
        "project",
      );
      assert.equal(
        manager.has(
          "project",
        ),
        false,
      );

      const persistedAfterDelete =
        JSON.parse(
          await readFile(
            statePath,
            "utf8",
          ),
        ) as {
          workspaces:
            unknown[];
        };
      assert.deepEqual(
        persistedAfterDelete
          .workspaces,
        [],
      );

      await readFile(
        join(
          projectRoot,
          ".",
        ),
      ).catch(
        (error: unknown) => {
          const code =
            (
              error as {
                code?: string;
              }
            ).code;
          assert.notEqual(
            code,
            "ENOENT",
          );
        },
      );
    } finally {
      await rm(
        stateRoot,
        {
          recursive: true,
          force: true,
        },
      );
      await rm(
        projectRoot,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);
