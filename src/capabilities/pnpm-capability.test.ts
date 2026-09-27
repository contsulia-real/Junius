import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  delimiter,
  join,
} from "node:path";
import test from "node:test";
import {
  isAllowedPnpmArgs,
  resolvePnpmLauncher,
} from "./pnpm-capability.js";

test("pnpm capability allows version and package scripts", () => {
  assert.equal(isAllowedPnpmArgs(["--version"]), true);
  assert.equal(isAllowedPnpmArgs(["run", "check"]), true);
  assert.equal(isAllowedPnpmArgs(["run", "test:unit"]), true);
  assert.equal(
    isAllowedPnpmArgs([
      "run",
      "test",
      "--",
      "--test-name-pattern",
      "demo",
    ]),
    true,
  );
});

test("pnpm capability does not expose package-management or arbitrary execution commands", () => {
  for (const args of [
    ["install"],
    ["add", "left-pad"],
    ["exec", "powershell"],
    ["dlx", "some-package"],
    ["run"],
    ["run", "../bad"],
  ]) {
    assert.equal(isAllowedPnpmArgs(args), false, args.join(" "));
  }
});

test("pnpm launcher follows PATH order", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-pnpm-path-"),
  );
  const first = join(root, "first");
  const second = join(root, "second");

  try {
    await Promise.all([
      mkdir(first, { recursive: true }),
      mkdir(second, { recursive: true }),
    ]);

    const fileName =
      process.platform === "win32"
        ? "pnpm.exe"
        : "pnpm";
    const firstExecutable = join(first, fileName);
    const secondExecutable = join(second, fileName);

    await writeFile(firstExecutable, "first", "utf8");
    await writeFile(secondExecutable, "second", "utf8");

    assert.deepEqual(
      resolvePnpmLauncher(
        {
          PATH: [first, second].join(delimiter),
          PNPM_HOME: second,
          npm_execpath: secondExecutable,
        },
        process.execPath,
      ),
      {
        executable: firstExecutable,
        fixedArgs: [],
      },
    );

    assert.deepEqual(
      resolvePnpmLauncher(
        {
          PATH: [second, first].join(delimiter),
        },
        process.execPath,
      ),
      {
        executable: secondExecutable,
        fixedArgs: [],
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
