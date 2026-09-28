import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";

test(
  "WorkspaceManager registers and lists independent roots",
  async () => {
    const firstRaw =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-workspaces-",
        ),
      );
    const secondRaw =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-workspaces-",
        ),
      );
    const first =
      await realpath(
        firstRaw,
      );
    const second =
      await realpath(
        secondRaw,
      );

    try {
      const manager =
        new WorkspaceManager([
          {
            id: "alpha",
            profile:
              new WorkspaceProfile(
                first,
              ),
          },
        ]);

      const created =
        await manager.register(
          "beta",
          second,
        );

      assert.deepEqual(
        created,
        {
          id: "beta",
          rootPath: second,
        },
      );
      assert.deepEqual(
        manager.list(),
        [
          {
            id: "alpha",
            rootPath: first,
          },
          {
            id: "beta",
            rootPath: second,
          },
        ],
      );

      assert.deepEqual(
        manager.remove(
          "beta",
        ),
        {
          id: "beta",
          rootPath: second,
        },
      );
      assert.equal(
        manager.has("beta"),
        false,
      );
    } finally {
      await rm(
        first,
        {
          recursive: true,
          force: true,
        },
      );
      await rm(
        second,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);

test(
  "WorkspaceManager replace is atomic with respect to invalid duplicate roots",
  async () => {
    const firstRaw =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-workspaces-",
        ),
      );
    const secondRaw =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-workspaces-",
        ),
      );
    const first =
      await realpath(
        firstRaw,
      );
    const second =
      await realpath(
        secondRaw,
      );

    try {
      const manager =
        new WorkspaceManager([
          {
            id: "alpha",
            profile:
              new WorkspaceProfile(
                first,
              ),
          },
        ]);

      manager.replace([
        {
          id: "beta",
          rootPath: second,
        },
      ]);
      assert.equal(
        manager.has("alpha"),
        false,
      );
      assert.equal(
        manager.has("beta"),
        true,
      );

      assert.throws(
        () =>
          manager.replace([
            {
              id: "first",
              rootPath: first,
            },
            {
              id: "second",
              rootPath: first,
            },
          ]),
        /workspace_root_already_registered/u,
      );

      assert.equal(
        manager.has("beta"),
        true,
      );
      assert.equal(
        manager.has("first"),
        false,
      );
    } finally {
      await rm(
        first,
        {
          recursive: true,
          force: true,
        },
      );
      await rm(
        second,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);

test(
  "WorkspaceManager rejects duplicate IDs and duplicate roots",
  async () => {
    const raw =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-workspaces-",
        ),
      );
    const root =
      await realpath(raw);

    try {
      const manager =
        new WorkspaceManager([
          {
            id: "alpha",
            profile:
              new WorkspaceProfile(
                root,
              ),
          },
        ]);

      await assert.rejects(
        manager.register(
          "alpha",
          root,
        ),
        /workspace_id_already_registered/u,
      );

      await assert.rejects(
        manager.register(
          "beta",
          root,
        ),
        /workspace_root_already_registered/u,
      );
    } finally {
      await rm(
        root,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);
