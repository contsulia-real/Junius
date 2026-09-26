import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceFilesService, WorkspaceFileError } from "./workspace-files.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";

async function fixture(): Promise<{
  readonly root: string;
  readonly service: WorkspaceFilesService;
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "junius-files-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "one\ntwo\nthree\n", "utf8");
  await writeFile(join(root, "README.md"), "# Demo\n", "utf8");

  const manager = new WorkspaceManager([
    {
      id: "demo",
      profile: new WorkspaceProfile(root),
    },
  ]);

  return {
    root,
    service: new WorkspaceFilesService(manager),
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("ls lists Workspace-relative entries", async () => {
  const f = await fixture();
  try {
    const entries = await f.service.ls("demo", ".", 2);
    assert.deepEqual(
      entries.map((entry) => [entry.path, entry.type]),
      [
        ["README.md", "file"],
        ["src", "directory"],
        [join("src", "a.ts"), "file"],
      ],
    );
  } finally {
    await f.dispose();
  }
});

test("read returns line ranges", async () => {
  const f = await fixture();
  try {
    const [result] = await f.service.read("demo", [
      { path: "src/a.ts", startLine: 2, endLine: 3 },
    ]);

    assert.equal(result?.content, "two\nthree\n");
    assert.equal(result?.startLine, 2);
    assert.equal(result?.endLine, 3);
  } finally {
    await f.dispose();
  }
});

test("write can overwrite an existing file without a prior read", async () => {
  const f = await fixture();
  try {
    const [written] = await f.service.write("demo", [
      {
        path: "README.md",
        content: "# Changed\n",
      },
    ]);

    assert.equal(written?.created, false);
    assert.equal(
      await readFile(join(f.root, "README.md"), "utf8"),
      "# Changed\n",
    );
  } finally {
    await f.dispose();
  }
});

test("write validates all files before changing any of them", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.write("demo", [
        {
          path: "README.md",
          content: "# Must not be written\n",
        },
        {
          path: "src/a.ts",
          edits: [
            {
              oldText: "missing text",
              newText: "bad",
            },
          ],
        },
      ]),
      (error: unknown) =>
        error instanceof WorkspaceFileError &&
        error.code === "edit_not_found",
    );

    assert.equal(
      await readFile(join(f.root, "README.md"), "utf8"),
      "# Demo\n",
    );
  } finally {
    await f.dispose();
  }
});

test("write can create a new nested file inside the Workspace", async () => {
  const f = await fixture();
  try {
    const [written] = await f.service.write("demo", [
      {
        path: "generated/nested.txt",
        content: "ok\n",
      },
    ]);

    assert.equal(written?.created, true);
    assert.equal(
      await readFile(join(f.root, "generated", "nested.txt"), "utf8"),
      "ok\n",
    );
  } finally {
    await f.dispose();
  }
});

test("Workspace file tools reject path traversal", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.read("demo", [{ path: "../outside.txt" }]),
      (error: unknown) =>
        error instanceof WorkspaceFileError &&
        error.code === "invalid_path",
    );

    await assert.rejects(
      f.service.write("demo", [
        { path: "../outside.txt", content: "no" },
      ]),
      (error: unknown) =>
        error instanceof WorkspaceFileError &&
        error.code === "invalid_path",
    );
  } finally {
    await f.dispose();
  }
});

test("Workspace file tools reject unregistered Workspaces", async () => {
  const manager = new WorkspaceManager();
  const service = new WorkspaceFilesService(manager);

  await assert.rejects(
    service.ls("missing"),
    (error: unknown) =>
      error instanceof WorkspaceFileError &&
      error.code === "workspace_not_registered",
  );
});


test("write supports exact-text edits without replacing the whole file", async () => {
  const f = await fixture();
  try {
    const [written] = await f.service.write("demo", [
      {
        path: "src/a.ts",
        edits: [
          {
            oldText: "two\n",
            newText: "changed\n",
          },
        ],
      },
    ]);

    assert.equal(written?.created, false);
    assert.equal(
      await readFile(join(f.root, "src", "a.ts"), "utf8"),
      "one\nchanged\nthree\n",
    );
  } finally {
    await f.dispose();
  }
});

test("write rejects ambiguous exact-text edits", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "dup.txt"), "same\nsame\n", "utf8");
    await assert.rejects(
      f.service.write("demo", [
        {
          path: "dup.txt",
          edits: [
            {
              oldText: "same",
              newText: "changed",
            },
          ],
        },
      ]),
      (error: unknown) =>
        error instanceof WorkspaceFileError &&
        error.code === "edit_not_unique",
    );
  } finally {
    await f.dispose();
  }
});
