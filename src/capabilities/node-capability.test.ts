import assert from "node:assert/strict";
import {
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
  createNodeCapability,
  resolveNodeExecutable,
} from "./node-capability.js";

test("node capability strips inherited Node preload environment", () => {
  const capability = createNodeCapability(
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

test("resolveNodeExecutable follows PATH order", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-node-path-"),
  );
  const first = join(root, "first");
  const second = join(root, "second");

  try {
    await import("node:fs/promises").then(
      ({ mkdir }) =>
        Promise.all([
          mkdir(first, { recursive: true }),
          mkdir(second, { recursive: true }),
        ]),
    );

    const fileName =
      process.platform === "win32"
        ? "node.exe"
        : "node";

    await writeFile(
      join(first, fileName),
      "first",
      "utf8",
    );
    await writeFile(
      join(second, fileName),
      "second",
      "utf8",
    );

    assert.equal(
      resolveNodeExecutable({
        PATH: [first, second].join(delimiter),
      }),
      join(first, fileName),
    );

    assert.equal(
      resolveNodeExecutable({
        PATH: [second, first].join(delimiter),
      }),
      join(second, fileName),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveNodeExecutable returns undefined when PATH has no node", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-node-path-empty-"),
  );

  try {
    assert.equal(
      resolveNodeExecutable({ PATH: root }),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
