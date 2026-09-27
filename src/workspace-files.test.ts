import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("Workspace file tools reject links that escape the Workspace", async () => {
  const f = await fixture();
  const outside = await mkdtemp(
    join(tmpdir(), "junius-files-outside-"),
  );

  try {
    await writeFile(
      join(outside, "secret.txt"),
      "outside\n",
      "utf8",
    );
    await symlink(
      outside,
      join(f.root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await assert.rejects(
      f.service.read("demo", [
        { path: "escape/secret.txt" },
      ]),
      (error: unknown) =>
        error instanceof WorkspaceFileError &&
        error.code === "path_outside_workspace",
    );

    await assert.rejects(
      f.service.write("demo", [
        {
          path: "escape/new.txt",
          content: "no\n",
        },
      ]),
      (error: unknown) =>
        error instanceof WorkspaceFileError &&
        error.code === "path_outside_workspace",
    );

    await assert.rejects(
      readFile(join(outside, "new.txt"), "utf8"),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT",
    );
  } finally {
    await f.dispose();
    await rm(outside, { recursive: true, force: true });
  }
});

test("Workspace writes reject symbolic or junction parent aliases inside the Workspace", async () => {
  const f = await fixture();

  try {
    await mkdir(join(f.root, "real"), {
      recursive: true,
    });
    await symlink(
      join(f.root, "real"),
      join(f.root, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await assert.rejects(
      f.service.write("demo", [
        {
          path: "alias/new.txt",
          content: "no\n",
        },
      ]),
      (error: unknown) =>
        error instanceof WorkspaceFileError &&
        error.code === "invalid_path",
    );

    await assert.rejects(
      readFile(join(f.root, "real", "new.txt"), "utf8"),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT",
    );
  } finally {
    await f.dispose();
  }
});

test("Workspace file tools reserve the root .junius control directory", async () => {
  const f = await fixture();

  try {
    await mkdir(
      join(f.root, ".junius", "runtime"),
      { recursive: true },
    );
    await writeFile(
      join(
        f.root,
        ".junius",
        "runtime",
        "secret.txt",
      ),
      "internal\n",
      "utf8",
    );

    for (const path of [
      ".junius/runtime/secret.txt",
      ".JuNiUs/runtime/secret.txt",
    ]) {
      await assert.rejects(
        f.service.read("demo", [{ path }]),
        (error: unknown) =>
          error instanceof WorkspaceFileError &&
          error.code === "invalid_path",
      );

      await assert.rejects(
        f.service.write("demo", [
          {
            path: path.replace("secret.txt", "new.txt"),
            content: "no\n",
          },
        ]),
        (error: unknown) =>
          error instanceof WorkspaceFileError &&
          error.code === "invalid_path",
      );
    }

    const listed = await f.service.ls(
      "demo",
      ".",
      2,
    );
    assert.equal(
      listed.some((entry) =>
        entry.path
          .replaceAll("\\", "/")
          .toLowerCase()
          .startsWith(".junius"),
      ),
      false,
    );
  } finally {
    await f.dispose();
  }
});

test("Workspace file tools reject aliases into the .junius control directory", async () => {
  const f = await fixture();

  try {
    await mkdir(
      join(f.root, ".junius", "runtime"),
      { recursive: true },
    );
    await writeFile(
      join(
        f.root,
        ".junius",
        "runtime",
        "secret.txt",
      ),
      "internal\n",
      "utf8",
    );
    await symlink(
      join(f.root, ".junius"),
      join(f.root, "control-alias"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await assert.rejects(
      f.service.read("demo", [
        {
          path: "control-alias/runtime/secret.txt",
        },
      ]),
      (error: unknown) =>
        error instanceof WorkspaceFileError &&
        error.code === "invalid_path",
    );

    await assert.rejects(
      f.service.write("demo", [
        {
          path: "control-alias/runtime/new.txt",
          content: "no\n",
        },
      ]),
      (error: unknown) =>
        error instanceof WorkspaceFileError &&
        error.code === "invalid_path",
    );
  } finally {
    await f.dispose();
  }
});

test("Workspace file tools protect configured internal state paths", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-files-protected-"),
  );
  const protectedRoot = join(root, "runtime-state");
  const publicPath = join(root, "public.txt");

  await mkdir(protectedRoot, { recursive: true });
  await writeFile(
    join(protectedRoot, "secret.txt"),
    "needle\n",
    "utf8",
  );
  await writeFile(
    publicPath,
    "needle\n",
    "utf8",
  );

  const manager = new WorkspaceManager([
    {
      id: "demo",
      profile: new WorkspaceProfile(root),
    },
  ]);
  const service = new WorkspaceFilesService(
    manager,
    [protectedRoot],
  );

  try {
    await assert.rejects(
      service.read("demo", [
        { path: "runtime-state/secret.txt" },
      ]),
      (error: unknown) =>
        error instanceof WorkspaceFileError &&
        error.code === "invalid_path",
    );

    await assert.rejects(
      service.write("demo", [
        {
          path: "runtime-state/new.txt",
          content: "no\n",
        },
      ]),
      (error: unknown) =>
        error instanceof WorkspaceFileError &&
        error.code === "invalid_path",
    );

    const listed = await service.ls("demo", ".", 2);
    assert.equal(
      listed.some((entry) =>
        entry.path
          .replaceAll("\\", "/")
          .startsWith("runtime-state"),
      ),
      false,
    );

    const matches = await service.rg("demo", {
      query: "needle",
      path: ".",
      hidden: true,
      fixedStrings: true,
      caseSensitive: true,
      maxResults: 20,
    });
    assert.deepEqual(
      matches.map((match) =>
        match.path.replaceAll("\\", "/"),
      ),
      ["public.txt"],
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("rg cannot re-include protected .junius state with user globs", async () => {
  const f = await fixture();

  try {
    await mkdir(join(f.root, ".junius"), {
      recursive: true,
    });
    await writeFile(
      join(f.root, ".junius", "secret.txt"),
      "needle\n",
      "utf8",
    );
    await writeFile(
      join(f.root, "public.txt"),
      "needle\n",
      "utf8",
    );

    const matches = await f.service.rg("demo", {
      query: "needle",
      path: ".",
      globs: [".junius/**", "**"],
      hidden: true,
      fixedStrings: true,
      caseSensitive: true,
      maxResults: 20,
    });

    assert.deepEqual(
      matches.map((match) =>
        match.path.replaceAll("\\", "/"),
      ),
      ["public.txt"],
    );
  } finally {
    await f.dispose();
  }
});

test("ls does not recurse through Workspace symlinks or junctions outside the root", async () => {
  const f = await fixture();
  const outside = await mkdtemp(
    join(tmpdir(), "junius-ls-outside-"),
  );

  try {
    await writeFile(
      join(outside, "secret.txt"),
      "outside-secret\n",
      "utf8",
    );
    await mkdir(join(f.root, "nested"), {
      recursive: true,
    });
    await symlink(
      outside,
      join(f.root, "nested", "external"),
      process.platform === "win32"
        ? "junction"
        : "dir",
    );

    const listed = await f.service.ls(
      "demo",
      ".",
      4,
    );

    const external = listed.find(
      (entry) =>
        entry.path
          .replaceAll("\\", "/")
          .toLowerCase() ===
        "nested/external",
    );
    assert.equal(external?.type, "symlink");
    assert.equal(
      listed.some((entry) =>
        entry.path
          .replaceAll("\\", "/")
          .toLowerCase()
          .startsWith("nested/external/"),
      ),
      false,
    );
  } finally {
    await f.dispose();
    await rm(outside, {
      recursive: true,
      force: true,
    });
  }
});

test("rg does not follow Workspace symlinks or junctions outside the root", async () => {
  const f = await fixture();
  const outside = await mkdtemp(
    join(tmpdir(), "junius-rg-outside-"),
  );

  try {
    await writeFile(
      join(outside, "secret.txt"),
      "outside-needle\n",
      "utf8",
    );
    await symlink(
      outside,
      join(f.root, "external"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const matches = await f.service.rg("demo", {
      query: "outside-needle",
      path: ".",
      hidden: true,
      fixedStrings: true,
      caseSensitive: true,
      maxResults: 20,
    });

    assert.deepEqual(matches, []);
  } finally {
    await f.dispose();
    await rm(outside, {
      recursive: true,
      force: true,
    });
  }
});

test("Workspace file tools reserve Git metadata at every depth", async () => {
  const f = await fixture();

  try {
    await mkdir(join(f.root, ".git"), {
      recursive: true,
    });
    await writeFile(
      join(f.root, ".git", "config"),
      "needle-git\n",
      "utf8",
    );
    await mkdir(
      join(f.root, "nested", ".git"),
      { recursive: true },
    );
    await writeFile(
      join(f.root, "nested", ".git", "config"),
      "needle-git\n",
      "utf8",
    );

    for (const path of [
      ".git/config",
      "nested/.git/config",
    ]) {
      await assert.rejects(
        f.service.read("demo", [{ path }]),
        (error: unknown) =>
          error instanceof WorkspaceFileError &&
          error.code === "invalid_path",
      );
    }

    const listed = await f.service.ls("demo", ".", 4);
    assert.equal(
      listed.some((entry) =>
        entry.path
          .replaceAll("\\", "/")
          .split("/")
          .some((segment) => segment.toLowerCase() === ".git"),
      ),
      false,
    );

    const matches = await f.service.rg("demo", {
      query: "needle-git",
      path: ".",
      globs: ["**/.git/**", "**"],
      hidden: true,
      fixedStrings: true,
      caseSensitive: true,
      maxResults: 20,
    });
    assert.deepEqual(matches, []);
  } finally {
    await f.dispose();
  }
});

test("Workspace file tools reject aliases into Git metadata", async () => {
  const f = await fixture();

  try {
    await mkdir(join(f.root, ".git"), {
      recursive: true,
    });
    await writeFile(
      join(f.root, ".git", "config"),
      "secret\n",
      "utf8",
    );
    await symlink(
      join(f.root, ".git"),
      join(f.root, "git-alias"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await assert.rejects(
      f.service.read("demo", [
        { path: "git-alias/config" },
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
