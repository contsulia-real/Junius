import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runWorkspaceReadBatch,
} from "./workspace-batch.js";
import { WorkspaceFilesService } from "./workspace-files.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";

async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), "junius-workspace-batch-"),
  );
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "a.ts"),
    "alpha\nbeta\ngamma\n",
    "utf8",
  );
  await writeFile(
    join(root, "README.md"),
    "# alpha demo\n",
    "utf8",
  );

  const files = new WorkspaceFilesService(
    new WorkspaceManager([
      {
        id: "demo",
        profile: new WorkspaceProfile(root),
      },
    ]),
  );

  return {
    root,
    files,
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("workspace read batch executes ls/read/rg in one operation", async () => {
  const f = await fixture();

  try {
    const result = await runWorkspaceReadBatch(
      f.files,
      "demo",
      [
        {
          id: "tree",
          op: "ls",
          path: ".",
          depth: 2,
        },
        {
          id: "source",
          op: "read",
          files: [
            {
              path: "src/a.ts",
              startLine: 2,
              endLine: 3,
            },
          ],
        },
        {
          id: "search",
          op: "rg",
          query: "alpha",
          fixedStrings: true,
          caseSensitive: true,
          maxResults: 10,
        },
      ],
    );

    assert.equal(result.workspace, "demo");
    assert.equal(result.results.length, 3);
    assert.equal(
      (result.results[0] as { ok: boolean }).ok,
      true,
    );
    assert.deepEqual(
      (
        result.results[1] as {
          files: { content: string }[];
        }
      ).files.map((file) => file.content),
      ["beta\ngamma\n"],
    );
    assert.equal(
      (
        result.results[2] as {
          matches: unknown[];
        }
      ).matches.length,
      2,
    );
  } finally {
    await f.dispose();
  }
});

test("workspace read batch isolates expected file-operation failures", async () => {
  const f = await fixture();

  try {
    const result = await runWorkspaceReadBatch(
      f.files,
      "demo",
      [
        {
          id: "missing",
          op: "read",
          files: [{ path: "missing.txt" }],
        },
        {
          id: "valid",
          op: "read",
          files: [{ path: "README.md" }],
        },
      ],
    );

    assert.deepEqual(
      result.results.map((item) => {
        const record = item as {
          id?: string;
          ok?: boolean;
          code?: string;
        };
        return {
          id: record.id,
          ok: record.ok,
          code: record.code,
        };
      }),
      [
        {
          id: "missing",
          ok: false,
          code: "path_not_found",
        },
        {
          id: "valid",
          ok: true,
          code: undefined,
        },
      ],
    );
  } finally {
    await f.dispose();
  }
});
