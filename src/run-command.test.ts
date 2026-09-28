import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunCommandService } from "./run-command.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";

async function fixture() {
  const raw =
    await mkdtemp(
      join(
        tmpdir(),
        "junius-command-",
      ),
    );
  const root =
    await realpath(raw);
  const manager =
    new WorkspaceManager([
      {
        id: "demo",
        profile:
          new WorkspaceProfile(
            root,
          ),
      },
    ]);
  return {
    root,
    service:
      new RunCommandService(
        manager,
      ),
    async dispose() {
      await rm(
        root,
        {
          recursive: true,
          force: true,
        },
      );
    },
  };
}

test(
  "run_command rejects only an unknown Workspace before execution",
  async () => {
    const service =
      new RunCommandService(
        new WorkspaceManager(),
      );
    const result =
      await service.run(
        "missing",
        process.execPath,
        ["--version"],
      );

    assert.equal(
      result.ok,
      false,
    );
    if (!result.ok) {
      assert.equal(
        result.code,
        "workspace_not_registered",
      );
    }
  },
);

test(
  "run_command launches arbitrary executable arguments in the Workspace cwd",
  async () => {
    const f =
      await fixture();
    try {
      const result =
        await f.service.run(
          "demo",
          process.execPath,
          [
            "-e",
            "process.stdout.write(process.cwd())",
          ],
        );

      assert.equal(
        result.ok,
        true,
      );
      if (result.ok) {
        assert.equal(
          await realpath(
            result.execution
              .stdout,
          ),
          f.root,
        );
      }
    } finally {
      await f.dispose();
    }
  },
);

test(
  "run_command does not apply executable or argument allowlists",
  async () => {
    const f =
      await fixture();
    try {
      for (
        const output of [
          "first",
          "second",
        ]
      ) {
        const result =
          await f.service.run(
            "demo",
            process.execPath,
            [
              "-e",
              `process.stdout.write(${JSON.stringify(output)})`,
            ],
          );
        assert.equal(
          result.ok,
          true,
        );
        if (result.ok) {
          assert.equal(
            result.execution
              .stdout,
            output,
          );
        }
      }
    } finally {
      await f.dispose();
    }
  },
);

test(
  "run_command exposes the root-only Workspace catalog",
  () => {
    const service =
      new RunCommandService(
        new WorkspaceManager([
          {
            id: "alpha",
            profile:
              new WorkspaceProfile(
                "C:\\alpha",
              ),
          },
          {
            id: "beta",
            profile:
              new WorkspaceProfile(
                "C:\\beta",
              ),
          },
        ]),
      );

    assert.deepEqual(
      service.listWorkspaces(),
      [
        {
          id: "alpha",
          rootPath:
            "C:\\alpha",
        },
        {
          id: "beta",
          rootPath:
            "C:\\beta",
        },
      ],
    );
  },
);
