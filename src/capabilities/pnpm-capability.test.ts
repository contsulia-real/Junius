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
  createPnpmCapability,
  isAllowedPnpmArgs,
  resolvePnpmLauncher,
} from "./pnpm-capability.js";

test("pnpm capability strips inherited Node preload environment", () => {
  const capability = createPnpmCapability(
    {
      executable: process.execPath,
      fixedArgs: [],
    },
    {
      PATH: process.env.PATH,
      NODE_OPTIONS:
        "--require=definitely-missing-junius-module",
      node_path: "C:\\evil\\modules",
      SAFE_VALUE: "kept",
    },
  )!;

  const prepared = capability.prepareProcess(
    ["--version"],
    { cwd: process.cwd() },
  );

  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    assert.equal(
      prepared.process.env.NODE_OPTIONS,
      undefined,
    );
    assert.equal(
      prepared.process.env.node_path,
      undefined,
    );
    assert.equal(
      prepared.process.env.SAFE_VALUE,
      "kept",
    );
  }
});

test("pnpm capability policy allows bounded commands and blocks escape or arbitrary execution", () => {
  for (const args of [
    ["--version"],
    ["typecheck"],
    ["lint"],
    ["test"],
    ["build"],
    ["install"],
    ["install", "--frozen-lockfile"],
    ["update"],
    ["update", "typescript@latest"],
    ["self-update"],
    ["self-update", "12"],
    ["self-update", "next-12"],
    ["add", "react"],
    ["add", "-D", "typescript@latest"],
  ]) {
    assert.equal(isAllowedPnpmArgs(args), true, args.join(" "));
  }

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

  for (const args of [
    ["install", "--dir", ".."],
    ["install", "--dir=.."],
    ["update", "-C", ".."],
    ["update", "--global"],
    ["add"],
    ["add", "-g", "left-pad"],
    ["add", "left-pad", "--global-dir=C:\\\\tmp"],
    ["add", "left-pad", "--lockfile-dir", ".."],
    ["add", "left-pad", "--store-dir=..\\\\store"],
    ["install", "--state-dir", "C:\\\\tmp"],
    ["install", "--userconfig=C:\\\\tmp\\\\npmrc"],
    ["update", "--workspace-packages=../*"],
    ["update", "--filter", "{..}"],
    ["update", "-F../sibling"],
    ["install", "--recursive"],
    ["install", "--workspace-root"],
    ["self-update", "--force"],
    ["self-update", "12", "extra"],
    ["typecheck", "--watch"],
    ["lint", "--fix"],
    ["test", "--watch"],
    ["build", "--production"],
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
