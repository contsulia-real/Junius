import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { runSourceCheck } from "./source-check.js";

async function waitForProcessExit(
  pid: number,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 25),
    );
  }

  assert.fail("descendant_still_running_after_timeout");
}

test("runSourceCheck strips inherited preload and Junius instance environment", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-source-check-env-"),
  );
  const bin = join(root, "bin");
  const fakePnpm = join(bin, "pnpm.js");

  try {
    await mkdir(bin, { recursive: true });
    await writeFile(
      fakePnpm,
      [
        'if (process.env.NODE_OPTIONS || process.env.NODE_PATH || process.env.node_options) process.exit(9);',
        'if (process.env.JUNIUS_INSTANCE_ROLE || process.env.JUNIUS_MCP_PORT) process.exit(7);',
        'if (process.argv.slice(2).join(" ") !== "run check") process.exit(8);',
        'process.stdout.write("ok");',
        '',
      ].join("\n"),
      "utf8",
    );

    const result = await runSourceCheck(
      root,
      {
        ...process.env,
        PATH: [
          bin,
          process.env.PATH ?? "",
        ].filter(Boolean).join(delimiter),
        NODE_OPTIONS:
          "--require=definitely-missing-junius-module",
        NODE_PATH: "C:\\evil\\modules",
        node_options:
          "--require=another-missing-junius-module",
        JUNIUS_INSTANCE_ROLE:
          "development",
        JUNIUS_MCP_PORT:
          "18787",
      },
      5_000,
    );

    assert.equal(result.ok, true, result.stderr);
    assert.equal(result.stdout, "ok");
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("runSourceCheck timeout terminates descendant processes on Windows", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-source-check-"),
  );
  const bin = join(root, "bin");
  const marker = join(root, "descendant-alive");
  const descendant = join(root, "descendant.js");
  const fakePnpm = join(bin, "pnpm.js");

  try {
    await mkdir(bin, { recursive: true });

    await writeFile(
      descendant,
      [
        'setInterval(() => {}, 1000);',
        '',
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      fakePnpm,
      [
        'const fs = require("node:fs");',
        'const { spawn } = require("node:child_process");',
        'const child = spawn(',
        '  process.execPath,',
        '  [process.env.JUNIUS_TEST_DESCENDANT],',
        '  { stdio: "ignore" }',
        ');',
        'fs.writeFileSync(process.env.JUNIUS_TEST_MARKER, String(child.pid));',
        'setInterval(() => {}, 1000);',
        '',
      ].join("\n"),
      "utf8",
    );

    const result = await runSourceCheck(
      root,
      {
        ...process.env,
        PATH: [
          bin,
          process.env.PATH ?? "",
        ].filter(Boolean).join(delimiter),
        JUNIUS_TEST_DESCENDANT: descendant,
        JUNIUS_TEST_MARKER: marker,
      },
      750,
    );

    assert.equal(result.ok, false);

    const descendantPid = Number(
      await readFile(marker, "utf8"),
    );
    assert.equal(
      Number.isSafeInteger(descendantPid),
      true,
    );
    await waitForProcessExit(descendantPid);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
