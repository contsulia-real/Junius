import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  join,
} from "node:path";
import test from "node:test";
import {
  runCommandBatch,
} from "./command-batch.js";
import {
  RunCommandService,
} from "./run-command.js";
import {
  WorkspaceManager,
} from "./workspace-manager.js";
import {
  WorkspaceProfile,
} from "./workspace-profile.js";

async function fixture() {
  const raw =
    await mkdtemp(
      join(
        tmpdir(),
        "junius-command-batch-",
      ),
    );
  const root =
    await realpath(raw);
  const service =
    new RunCommandService(
      new WorkspaceManager([
        {
          id: "demo",
          profile:
            new WorkspaceProfile(
              root,
            ),
        },
      ]),
    );

  return {
    root,
    service,
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
  "runCommandBatch returns parallel command results in input order",
  async () => {
    const f =
      await fixture();
    try {
      const batch =
        await runCommandBatch(
          f.service,
          "demo",
          [
            {
              executable:
                process.execPath,
              args: [
                "-e",
                "process.stdout.write('first')",
              ],
            },
            {
              executable:
                process.execPath,
              args: [
                "-e",
                "process.stdout.write('second')",
              ],
            },
          ],
          "parallel",
          true,
        );

      assert.equal(
        batch.ok,
        true,
      );
      assert.equal(
        batch.items.length,
        2,
      );
      assert.equal(
        batch.items[0]
          ?.skipped,
        false,
      );
      assert.equal(
        batch.items[1]
          ?.skipped,
        false,
      );

      const first =
        batch.items[0];
      const second =
        batch.items[1];

      if (
        first === undefined ||
        first.skipped ||
        second === undefined ||
        second.skipped
      ) {
        assert.fail(
          "parallel items missing",
        );
      }

      assert.equal(
        first.result.ok &&
          first.result
            .execution.stdout,
        "first",
      );
      assert.equal(
        second.result.ok &&
          second.result
            .execution.stdout,
        "second",
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "runCommandBatch serial mode can stop after the first failure",
  async () => {
    const f =
      await fixture();
    const marker =
      join(
        f.root,
        "should-not-exist.txt",
      );

    try {
      const batch =
        await runCommandBatch(
          f.service,
          "demo",
          [
            {
              executable:
                process.execPath,
              args: [
                "-e",
                "process.exit(7)",
              ],
            },
            {
              executable:
                process.execPath,
              args: [
                "-e",
                `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")`,
              ],
            },
          ],
          "serial",
          true,
        );

      assert.equal(
        batch.ok,
        false,
      );
      assert.equal(
        batch.stoppedEarly,
        true,
      );
      assert.equal(
        batch.items[1]
          ?.skipped,
        true,
      );

      await assert.rejects(
        access(marker),
      );
    } finally {
      await f.dispose();
    }
  },
);
