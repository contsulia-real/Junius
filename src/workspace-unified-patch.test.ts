import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseUnifiedPatch,
} from "./workspace-unified-patch.js";
import {
  WorkspaceFileError,
  WorkspaceFilesService,
} from "./workspace-files.js";
import {
  WorkspaceManager,
} from "./workspace-manager.js";
import {
  WorkspaceProfile,
} from "./workspace-profile.js";

async function fixture() {
  const root =
    await mkdtemp(
      join(
        tmpdir(),
        "junius-patch-",
      ),
    );
  await mkdir(
    join(root, "src"),
    { recursive: true },
  );
  await writeFile(
    join(
      root,
      "src",
      "a.ts",
    ),
    "alpha\nbeta\ngamma\ndelta\n",
    "utf8",
  );
  await writeFile(
    join(
      root,
      "README.md",
    ),
    "# Demo\n",
    "utf8",
  );

  return {
    root,
    service:
      new WorkspaceFilesService(
        new WorkspaceManager([
          {
            id: "demo",
            profile:
              new WorkspaceProfile(
                root,
              ),
          },
        ]),
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
  "unified patch modifies and creates multiple files transactionally",
  async () => {
    const f =
      await fixture();

    try {
      const writes =
        parseUnifiedPatch(
          [
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -1,4 +1,5 @@",
            " alpha",
            "-beta",
            "+beta changed",
            " gamma",
            "+inserted",
            " delta",
            "--- /dev/null",
            "+++ b/src/new.ts",
            "@@ -0,0 +1,2 @@",
            "+one",
            "+two",
            "",
          ].join("\n"),
        );

      const result =
        await f.service.write(
          "demo",
          writes,
          "workspace_patch",
        );

      assert.equal(
        result.length,
        2,
      );
      assert.equal(
        await readFile(
          join(
            f.root,
            "src",
            "a.ts",
          ),
          "utf8",
        ),
        "alpha\nbeta changed\ngamma\ninserted\ndelta\n",
      );
      assert.equal(
        await readFile(
          join(
            f.root,
            "src",
            "new.ts",
          ),
          "utf8",
        ),
        "one\ntwo\n",
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "zero-count unified hunk inserts after the referenced source line",
  async () => {
    const f =
      await fixture();

    try {
      const writes =
        parseUnifiedPatch(
          [
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -2,0 +3,1 @@",
            "+between",
            "",
          ].join("\n"),
        );

      await f.service.write(
        "demo",
        writes,
        "workspace_patch",
      );

      assert.equal(
        await readFile(
          join(
            f.root,
            "src",
            "a.ts",
          ),
          "utf8",
        ),
        "alpha\nbeta\nbetween\ngamma\ndelta\n",
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "unified patch preserves CRLF for an existing file",
  async () => {
    const f =
      await fixture();

    try {
      await writeFile(
        join(
          f.root,
          "src",
          "a.ts",
        ),
        "alpha\r\nbeta\r\n",
        "utf8",
      );

      const writes =
        parseUnifiedPatch(
          [
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -1,2 +1,2 @@",
            " alpha",
            "-beta",
            "+changed",
            "",
          ].join("\n"),
        );

      await f.service.write(
        "demo",
        writes,
        "workspace_patch",
      );

      assert.equal(
        await readFile(
          join(
            f.root,
            "src",
            "a.ts",
          ),
          "utf8",
        ),
        "alpha\r\nchanged\r\n",
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "one mismatched unified hunk prevents every file in the transaction from changing",
  async () => {
    const f =
      await fixture();

    try {
      const writes =
        parseUnifiedPatch(
          [
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -1,1 +1,1 @@",
            "-alpha",
            "+changed",
            "--- a/README.md",
            "+++ b/README.md",
            "@@ -1,1 +1,1 @@",
            "-# Wrong",
            "+# Changed",
            "",
          ].join("\n"),
        );

      await assert.rejects(
        f.service.write(
          "demo",
          writes,
          "workspace_patch",
        ),
        (
          error: unknown,
        ) =>
          error instanceof
            WorkspaceFileError &&
          error.code ===
            "edit_not_found",
      );

      assert.equal(
        await readFile(
          join(
            f.root,
            "src",
            "a.ts",
          ),
          "utf8",
        ),
        "alpha\nbeta\ngamma\ndelta\n",
      );
      assert.equal(
        await readFile(
          join(
            f.root,
            "README.md",
          ),
          "utf8",
        ),
        "# Demo\n",
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "workspace unified patch rejects file deletion instead of silently changing semantics",
  () => {
    assert.throws(
      () =>
        parseUnifiedPatch(
          [
            "--- a/README.md",
            "+++ /dev/null",
            "@@ -1,1 +0,0 @@",
            "-# Demo",
            "",
          ].join("\n"),
        ),
      (
        error: unknown,
      ) =>
        error instanceof
          WorkspaceFileError &&
        error.code ===
          "invalid_write" &&
        /deletion/u.test(
          error.message,
        ),
    );
  },
);
