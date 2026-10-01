import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceFileError, WorkspaceFilesService } from "./workspace-files.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "junius-mutation-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "alpha\nbeta\n", "utf8");
  await writeFile(join(root, "src", "move.ts"), "move me\n", "utf8");
  await writeFile(join(root, "README.md"), "# Demo\n", "utf8");
  const service = new WorkspaceFilesService(
    new WorkspaceManager([{ id: "demo", profile: new WorkspaceProfile(root) }]),
  );
  return {
    root,
    service,
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function missing(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return false;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }
}

test("ordinary Workspace mutations persist independently across later failures", async () => {
  const f = await fixture();
  try {
    await f.service.mutate(
      "demo",
      [{ kind: "write", path: "src/a.ts", content: "first change\n" }],
      "write_file",
    );
    await f.service.mutate(
      "demo",
      [{ kind: "write", path: "src/b.ts", content: "second change\n" }],
      "write_file",
    );
    await assert.rejects(
      f.service.mutate(
        "demo",
        [{ kind: "delete", path: "missing.ts" }],
        "delete_file",
      ),
      (error: unknown) => error instanceof WorkspaceFileError && error.code === "path_not_found",
    );
    assert.equal(await readFile(join(f.root, "src", "a.ts"), "utf8"), "first change\n");
    assert.equal(await readFile(join(f.root, "src", "b.ts"), "utf8"), "second change\n");
  } finally {
    await f.dispose();
  }
});

test("incremental Workspace mutations accumulate in one Git working tree", async () => {
  const f = await fixture();
  try {
    const git = (...args: readonly string[]) =>
      execFileSync(
        "git",
        [...args],
        {
          cwd: f.root,
          encoding: "utf8",
          windowsHide: true,
        },
      );

    git("init");
    git("add", ".");
    git(
      "-c",
      "user.name=Junius Test",
      "-c",
      "user.email=junius@example.invalid",
      "commit",
      "-m",
      "baseline",
    );

    await f.service.mutate(
      "demo",
      [
        {
          kind: "write",
          path: "src/a.ts",
          content: "changed a\n",
        },
      ],
      "write_file",
    );
    await f.service.mutate(
      "demo",
      [
        {
          kind: "write",
          path: "src/move.ts",
          content: "changed b\n",
        },
      ],
      "write_file",
    );
    await f.service.mutate(
      "demo",
      [
        {
          kind: "delete",
          path: "README.md",
        },
      ],
      "delete_file",
    );

    const changed =
      new Set(
        git(
          "diff",
          "--name-status",
          "--",
        )
          .trim()
          .split(/\r?\n/u),
      );
    assert.deepEqual(
      changed,
      new Set([
        "D\tREADME.md",
        "M\tsrc/a.ts",
        "M\tsrc/move.ts",
      ]),
    );
  } finally {
    await f.dispose();
  }
});

test("explicit mixed Workspace mutation rolls every operation back on failure", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.mutate(
        "demo",
        [
          { kind: "write", path: "src/a.ts", content: "changed\n" },
          { kind: "write", path: "created/new.ts", content: "new\n" },
          { kind: "move", source: "src/move.ts", destination: "moved/move.ts" },
          { kind: "delete", path: "README.md" },
          { kind: "delete", path: "does-not-exist.txt" },
        ],
        "workspace_mutate",
      ),
      (error: unknown) => error instanceof WorkspaceFileError && error.code === "path_not_found",
    );
    assert.equal(await readFile(join(f.root, "src", "a.ts"), "utf8"), "alpha\nbeta\n");
    assert.equal(await readFile(join(f.root, "src", "move.ts"), "utf8"), "move me\n");
    assert.equal(await readFile(join(f.root, "README.md"), "utf8"), "# Demo\n");
    assert.equal(await missing(join(f.root, "created", "new.ts")), true);
    assert.equal(await missing(join(f.root, "moved", "move.ts")), true);
  } finally {
    await f.dispose();
  }
});

test("explicit Workspace transaction supports mkdir write copy move and delete together", async () => {
  const f = await fixture();
  try {
    const results = await f.service.mutate(
      "demo",
      [
        { kind: "mkdir", path: "generated/nested" },
        { kind: "write", path: "generated/nested/value.ts", content: "value\n" },
        { kind: "copy", source: "generated/nested/value.ts", destination: "generated/copy.ts" },
        { kind: "move", source: "src/move.ts", destination: "generated/moved.ts" },
        { kind: "delete", path: "README.md" },
      ],
      "workspace_mutate",
    );
    assert.deepEqual(results.map((result) => result.kind), ["mkdir", "write", "copy", "move", "delete"]);
    assert.equal(await readFile(join(f.root, "generated", "nested", "value.ts"), "utf8"), "value\n");
    assert.equal(await readFile(join(f.root, "generated", "copy.ts"), "utf8"), "value\n");
    assert.equal(await readFile(join(f.root, "generated", "moved.ts"), "utf8"), "move me\n");
    assert.equal(await missing(join(f.root, "src", "move.ts")), true);
    assert.equal(await missing(join(f.root, "README.md")), true);
  } finally {
    await f.dispose();
  }
});

test("destructive Workspace mutations keep protected path boundaries", async () => {
  const f = await fixture();
  try {
    await mkdir(
      join(f.root, ".git"),
      { recursive: true },
    );
    await writeFile(
      join(
        f.root,
        ".git",
        "config",
      ),
      "protected\n",
      "utf8",
    );
    await mkdir(
      join(f.root, ".junius"),
      { recursive: true },
    );

    await assert.rejects(
      f.service.mutate(
        "demo",
        [
          {
            kind: "delete",
            path: ".git/config",
          },
        ],
        "delete_file",
      ),
      (error: unknown) =>
        error instanceof
          WorkspaceFileError &&
        error.code ===
          "invalid_path",
    );

    await assert.rejects(
      f.service.mutate(
        "demo",
        [
          {
            kind: "move",
            source: "src/a.ts",
            destination:
              ".junius/a.ts",
          },
        ],
        "move_file",
      ),
      (error: unknown) =>
        error instanceof
          WorkspaceFileError &&
        error.code ===
          "invalid_path",
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
      "alpha\nbeta\n",
    );
  } finally {
    await f.dispose();
  }
});

test("Workspace copy preserves binary bytes", async () => {
  const f = await fixture();
  try {
    const content =
      Buffer.from([
        0,
        1,
        2,
        255,
        13,
        10,
      ]);
    await writeFile(
      join(
        f.root,
        "binary.bin",
      ),
      content,
    );

    await f.service.mutate(
      "demo",
      [
        {
          kind: "copy",
          source: "binary.bin",
          destination:
            "nested/copied.bin",
        },
      ],
      "copy_file",
    );

    assert.deepEqual(
      await readFile(
        join(
          f.root,
          "nested",
          "copied.bin",
        ),
      ),
      content,
    );
  } finally {
    await f.dispose();
  }
});

test("transaction rollback restores overwritten move source and destination", async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(
        f.root,
        "destination.txt",
      ),
      "original destination\n",
      "utf8",
    );

    await assert.rejects(
      f.service.mutate(
        "demo",
        [
          {
            kind: "move",
            source: "src/move.ts",
            destination:
              "destination.txt",
            overwrite: true,
          },
          {
            kind: "delete",
            path: "missing-after-move.txt",
          },
        ],
        "workspace_mutate",
      ),
      (error: unknown) =>
        error instanceof
          WorkspaceFileError &&
        error.code ===
          "path_not_found",
    );

    assert.equal(
      await readFile(
        join(
          f.root,
          "src",
          "move.ts",
        ),
        "utf8",
      ),
      "move me\n",
    );
    assert.equal(
      await readFile(
        join(
          f.root,
          "destination.txt",
        ),
        "utf8",
      ),
      "original destination\n",
    );
  } finally {
    await f.dispose();
  }
});

test("Workspace mutation cleanup leaves no Junius staging files", async () => {
  const f = await fixture();
  try {
    await f.service.mutate(
      "demo",
      [
        { kind: "copy", source: "src/a.ts", destination: "copy.ts" },
        { kind: "move", source: "src/move.ts", destination: "moved.ts" },
        { kind: "delete", path: "README.md" },
      ],
      "workspace_mutate",
    );
    const names: string[] = [];
    async function collect(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        names.push(entry.name);
        if (entry.isDirectory()) await collect(join(directory, entry.name));
      }
    }
    await collect(f.root);
    assert.equal(names.some((name) => name.startsWith(".junius-")), false);
  } finally {
    await f.dispose();
  }
});
