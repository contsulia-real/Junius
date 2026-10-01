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
        await f.service.mutate(
          "demo",
          writes,
          "apply_patch",
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

      await f.service.mutate(
        "demo",
        writes,
        "apply_patch",
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

      await f.service.mutate(
        "demo",
        writes,
        "apply_patch",
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
        f.service.mutate(
          "demo",
          writes,
          "apply_patch",
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
  "workspace unified patch deletes a file",
  async () => {
    const f =
      await fixture();

    try {
      const mutations =
        parseUnifiedPatch(
          [
            "--- a/README.md",
            "+++ /dev/null",
            "@@ -1,1 +0,0 @@",
            "-# Demo",
            "",
          ].join("\n"),
        );

      await f.service.mutate(
        "demo",
        mutations,
        "apply_patch",
      );

      await assert.rejects(
        readFile(
          join(
            f.root,
            "README.md",
          ),
          "utf8",
        ),
        (
          error: unknown,
        ) =>
          typeof error ===
            "object" &&
          error !== null &&
          "code" in error &&
          error.code ===
            "ENOENT",
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "workspace unified patch applies a pure Git rename",
  async () => {
    const f =
      await fixture();

    try {
      const mutations =
        parseUnifiedPatch(
          [
            "diff --git a/src/a.ts b/src/renamed.ts",
            "similarity index 100%",
            "rename from src/a.ts",
            "rename to src/renamed.ts",
            "",
          ].join("\n"),
        );

      await f.service.mutate(
        "demo",
        mutations,
        "apply_patch",
      );

      assert.equal(
        await readFile(
          join(
            f.root,
            "src",
            "renamed.ts",
          ),
          "utf8",
        ),
        "alpha\nbeta\ngamma\ndelta\n",
      );
      await assert.rejects(
        readFile(
          join(
            f.root,
            "src",
            "a.ts",
          ),
          "utf8",
        ),
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "workspace unified patch can rename and edit in one atomic patch",
  async () => {
    const f =
      await fixture();

    try {
      const mutations =
        parseUnifiedPatch(
          [
            "diff --git a/src/a.ts b/src/renamed.ts",
            "similarity index 80%",
            "rename from src/a.ts",
            "rename to src/renamed.ts",
            "--- a/src/a.ts",
            "+++ b/src/renamed.ts",
            "@@ -1,2 +1,2 @@",
            " alpha",
            "-beta",
            "+changed",
            "",
          ].join("\n"),
        );

      await f.service.mutate(
        "demo",
        mutations,
        "apply_patch",
      );

      assert.equal(
        await readFile(
          join(
            f.root,
            "src",
            "renamed.ts",
          ),
          "utf8",
        ),
        "alpha\nchanged\ngamma\ndelta\n",
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "unified patch line positions can edit one repeated occurrence without exact-text ambiguity",
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
        "duplicate\nkeep\nduplicate\n",
        "utf8",
      );

      const mutations =
        parseUnifiedPatch(
          [
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -3,1 +3,1 @@",
            "-duplicate",
            "+changed",
            "",
          ].join("\n"),
        );

      await f.service.mutate(
        "demo",
        mutations,
        "apply_patch",
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
        "duplicate\nkeep\nchanged\n",
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "unified patch accepts Git-quoted UTF-8 paths",
  async () => {
    const f =
      await fixture();

    try {
      const path =
        "src/quoted é.ts";
      await writeFile(
        join(f.root, path),
        "before\n",
        "utf8",
      );

      const mutations =
        parseUnifiedPatch(
          [
            '--- "a/src/quoted \\303\\251.ts"',
            '+++ "b/src/quoted \\303\\251.ts"',
            "@@ -1,1 +1,1 @@",
            "-before",
            "+after",
            "",
          ].join("\n"),
        );

      await f.service.mutate(
        "demo",
        mutations,
        "apply_patch",
      );

      assert.equal(
        await readFile(
          join(f.root, path),
          "utf8",
        ),
        "after\n",
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "unified patch is bounded by payload rather than a sixteen-file limit",
  async () => {
    const f =
      await fixture();

    try {
      const lines: string[] =
        [];
      for (
        let index = 0;
        index < 20;
        index += 1
      ) {
        lines.push(
          "--- /dev/null",
          "+++ b/generated/file-" +
            index +
            ".txt",
          "@@ -0,0 +1,1 @@",
          "+value-" + index,
        );
      }
      lines.push("");

      const mutations =
        parseUnifiedPatch(
          lines.join("\n"),
        );
      assert.equal(
        mutations.length,
        20,
      );

      await f.service.mutate(
        "demo",
        mutations,
        "apply_patch",
      );

      assert.equal(
        await readFile(
          join(
            f.root,
            "generated",
            "file-19.txt",
          ),
          "utf8",
        ),
        "value-19\n",
      );
    } finally {
      await f.dispose();
    }
  },
);
