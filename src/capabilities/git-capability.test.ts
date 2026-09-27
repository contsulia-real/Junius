import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createGitCapability,
  isAllowedGitArgs,
  resolveGitLauncher,
} from "./git-capability.js";

test("git capability allows repository development and synchronization commands", () => {
  const allowed: readonly (readonly string[])[] = [
    ["--version"],
    ["init"],
    ["init", "-b", "main"],
    ["status", "--short", "--branch"],
    ["add", "-A"],
    ["add", "--", "src/index.ts"],
    ["commit", "-m", "Sync local Junius"],
    ["config", "--get", "user.name"],
    ["config", "--local", "user.name", "Why23"],
    ["config", "--local", "user.email", "why23@example.invalid"],
    ["branch", "--show-current"],
    ["branch", "-M", "main"],
    ["remote", "-v"],
    ["remote", "add", "origin", "https://github.com/owner/repo.git"],
    ["remote", "set-url", "origin", "git@github.com:owner/repo.git"],
    ["remote", "get-url", "origin"],
    ["fetch", "origin"],
    ["push", "--force", "--set-upstream", "origin", "main"],
    ["rev-parse", "--is-inside-work-tree"],
    ["rev-parse", "--show-toplevel"],
    ["rev-parse", "HEAD"],
    ["diff", "--cached", "--stat"],
    ["log", "--oneline", "-n", "20"],
    ["ls-files"],
  ];

  for (const args of allowed) {
    assert.equal(
      isAllowedGitArgs(args),
      true,
      `expected git args to be allowed: ${JSON.stringify(args)}`,
    );
  }
});

test("git capability rejects destructive and arbitrary command shapes", () => {
  const rejected: readonly (readonly string[])[] = [
    ["clean", "-fdx"],
    ["reset", "--hard", "HEAD"],
    ["checkout", "--", "."],
    ["config", "--local", "alias.pwn", "!powershell"],
    ["remote", "add", "origin", "-dangerous"],
    ["push", "--mirror", "origin"],
    ["push", "--delete", "origin", "main"],
    ["add", "-f", "."],
    ["commit", "--amend", "--no-edit"],
  ];

  for (const args of rejected) {
    assert.equal(
      isAllowedGitArgs(args),
      false,
      `expected git args to be rejected: ${JSON.stringify(args)}`,
    );
  }
});

test("git launcher follows PATH order", async () => {
  const root = await mkdtemp(join(tmpdir(), "junius-git-"));
  const first = join(root, "first");
  const second = join(root, "second");

  try {
    const { mkdir } = await import("node:fs/promises");
    await Promise.all([
      mkdir(first, { recursive: true }),
      mkdir(second, { recursive: true }),
    ]);

    const fileName =
      process.platform === "win32"
        ? "git.exe"
        : "git";

    const firstExecutable = join(first, fileName);
    const secondExecutable = join(second, fileName);

    await writeFile(firstExecutable, "first", "utf8");
    await writeFile(secondExecutable, "second", "utf8");

    assert.deepEqual(
      resolveGitLauncher({
        PATH: [first, second].join(
          process.platform === "win32" ? ";" : ":",
        ),
      }),
      {
        executable: firstExecutable,
        fixedArgs: [],
      },
    );

    assert.deepEqual(
      resolveGitLauncher({
        PATH: [second, first].join(
          process.platform === "win32" ? ";" : ":",
        ),
      }),
      {
        executable: secondExecutable,
        fixedArgs: [],
      },
    );

    assert.equal(
      createGitCapability({
        executable: firstExecutable,
        fixedArgs: [],
      })?.key,
      "git",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
