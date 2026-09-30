import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  gitCommitPrepared,
  gitPrepareCommit,
  gitSnapshot,
} from "./git-workflow.js";
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
        "junius-git-workflow-",
      ),
    );
  const root =
    await realpath(raw);
  const service =
    new RunCommandService(
      new WorkspaceManager([
        {
          id: "repo",
          profile:
            new WorkspaceProfile(
              root,
            ),
        },
      ]),
    );

  const git = async (
    ...args: string[]
  ) => {
    const result =
      await service.run(
        "repo",
        "git",
        args,
      );
    if (!result.ok) {
      assert.fail(
        result.message,
      );
    }
    return result;
  };

  await git("init");
  await git(
    "config",
    "user.email",
    "junius@example.invalid",
  );
  await git(
    "config",
    "user.name",
    "Junius Test",
  );
  await writeFile(
    join(root, "a.txt"),
    "one\n",
    "utf8",
  );
  await git(
    "add",
    "--",
    "a.txt",
  );
  await git(
    "commit",
    "-m",
    "initial",
  );

  return {
    root,
    service,
    git,
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
  "gitSnapshot combines repository state in one operation",
  async () => {
    const f =
      await fixture();
    try {
      await writeFile(
        join(
          f.root,
          "a.txt",
        ),
        "two\n",
        "utf8",
      );
      await writeFile(
        join(
          f.root,
          "b.txt",
        ),
        "new\n",
        "utf8",
      );

      const snapshot =
        await gitSnapshot(
          f.service,
          "repo",
          3,
        );

      assert.equal(
        snapshot.ok,
        true,
      );
      assert.equal(
        snapshot.status.ok,
        true,
      );
      if (
        snapshot.status.ok
      ) {
        assert.match(
          snapshot.status
            .execution.stdout,
          /a\.txt/u,
        );
        assert.match(
          snapshot.status
            .execution.stdout,
          /b\.txt/u,
        );
      }
      assert.equal(
        snapshot
          .recentCommits.ok,
        true,
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "prepared commit tree prevents committing changed staged content",
  async () => {
    const f =
      await fixture();
    try {
      await writeFile(
        join(
          f.root,
          "a.txt",
        ),
        "two\n",
        "utf8",
      );
      await writeFile(
        join(
          f.root,
          "b.txt",
        ),
        "new\n",
        "utf8",
      );

      const prepared =
        await gitPrepareCommit(
          f.service,
          "repo",
          ["a.txt"],
        );

      assert.equal(
        prepared.ok,
        true,
      );
      assert.equal(
        typeof prepared.tree,
        "string",
      );
      assert.equal(
        prepared
          .stagedDiff
          ?.ok,
        true,
      );
      if (
        prepared
          .stagedDiff
          ?.ok
      ) {
        assert.match(
          prepared
            .stagedDiff
            .execution.stdout,
          /two/u,
        );
      }

      await f.git(
        "add",
        "--",
        "b.txt",
      );

      const rejected =
        await gitCommitPrepared(
          f.service,
          "repo",
          prepared.tree!,
          "should not commit",
        );

      assert.equal(
        rejected.ok,
        false,
      );
      if (!rejected.ok) {
        assert.equal(
          rejected.code,
          "staged_tree_changed",
        );
      }

      const reviewedAgain =
        await gitPrepareCommit(
          f.service,
          "repo",
          [
            "a.txt",
            "b.txt",
          ],
        );
      assert.equal(
        reviewedAgain.ok,
        true,
      );

      const committed =
        await gitCommitPrepared(
          f.service,
          "repo",
          reviewedAgain.tree!,
          "commit reviewed tree",
        );

      assert.equal(
        committed.ok,
        true,
      );
      if (committed.ok) {
        assert.equal(
          committed.status.ok,
          true,
        );
      }
    } finally {
      await f.dispose();
    }
  },
);
