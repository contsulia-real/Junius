import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runWorkspaceApply } from "./workspace-apply.js";
import {
  WorkspaceFileError,
  WorkspaceFilesService,
} from "./workspace-files.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";

async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), "junius-workspace-apply-"),
  );
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "a.ts"),
    "alpha\nbeta\n",
    "utf8",
  );
  await writeFile(
    join(root, "src", "b.ts"),
    "old\n",
    "utf8",
  );

  const service = new WorkspaceFilesService(
    new WorkspaceManager([
      {
        id: "demo",
        profile: new WorkspaceProfile(root),
      },
    ]),
  );

  return {
    root,
    service,
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("workspace_apply commits multiple files then verifies them in one operation", async () => {
  const f = await fixture();

  try {
    const result = await runWorkspaceApply(
      f.service,
      "demo",
      [
        {
          path: "src/a.ts",
          edits: [
            {
              oldText: "beta",
              newText: "gamma",
            },
          ],
        },
        {
          path: "src/b.ts",
          content: "new value\n",
        },
        {
          path: "generated/c.ts",
          content: "export const value = 1;\n",
        },
      ],
      [
        {
          id: "read-back",
          op: "read",
          files: [
            { path: "src/a.ts" },
            { path: "src/b.ts" },
          ],
        },
        {
          id: "search-old",
          op: "rg",
          query: "old",
          path: "src",
          fixedStrings: true,
          caseSensitive: true,
          maxResults: 20,
        },
      ],
    );

    assert.equal(result.writes.length, 3);
    assert.equal(
      await readFile(join(f.root, "src", "a.ts"), "utf8"),
      "alpha\ngamma\n",
    );
    assert.equal(
      await readFile(join(f.root, "src", "b.ts"), "utf8"),
      "new value\n",
    );
    assert.equal(
      await readFile(
        join(f.root, "generated", "c.ts"),
        "utf8",
      ),
      "export const value = 1;\n",
    );

    const verification = result.verification?.results;
    assert.equal(verification?.length, 2);
    assert.equal(
      (verification?.[0] as { ok?: boolean }).ok,
      true,
    );
    assert.deepEqual(
      (verification?.[1] as { matches?: unknown[] }).matches,
      [],
    );
    assert.equal(result.durationMs >= result.writeDurationMs, true);
  } finally {
    await f.dispose();
  }
});

test("transactional write rejects duplicate targets before changing files", async () => {
  const f = await fixture();

  try {
    await assert.rejects(
      f.service.write("demo", [
        {
          path: "src/a.ts",
          content: "first\n",
        },
        {
          path: "src/a.ts",
          content: "second\n",
        },
      ]),
      (error: unknown) =>
        error instanceof WorkspaceFileError &&
        error.code === "invalid_write",
    );

    assert.equal(
      await readFile(join(f.root, "src", "a.ts"), "utf8"),
      "alpha\nbeta\n",
    );
  } finally {
    await f.dispose();
  }
});

test("transactional write leaves no staging artifacts after successful commit", async () => {
  const f = await fixture();

  try {
    await f.service.write("demo", [
      {
        path: "src/a.ts",
        content: "changed\n",
      },
      {
        path: "nested/deeper/new.txt",
        content: "created\n",
      },
    ]);

    const allNames: string[] = [];

    async function collect(path: string): Promise<void> {
      for (const entry of await readdir(path, {
        withFileTypes: true,
      })) {
        allNames.push(entry.name);
        if (entry.isDirectory()) {
          await collect(join(path, entry.name));
        }
      }
    }

    await collect(f.root);

    assert.equal(
      allNames.some((name) =>
        name.startsWith(".junius-"),
      ),
      false,
    );
  } finally {
    await f.dispose();
  }
});
