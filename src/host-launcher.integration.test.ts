import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("manual launcher prefers the validated bootstrap copy", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-launcher-"),
  );
  const runtimeRoot = join(root, "runtime");
  const bootstrapRoot = join(
    runtimeRoot,
    "bootstrap",
  );
  const stableBootstrapPath = join(
    bootstrapRoot,
    "host-bootstrap.mjs",
  );
  const markerPath = join(root, "stable-used.txt");

  try {
    await mkdir(bootstrapRoot, { recursive: true });
    await writeFile(
      stableBootstrapPath,
      `
import { writeFile } from "node:fs/promises";
await writeFile(
  ${JSON.stringify(markerPath)},
  "stable",
  "utf8",
);
`,
      "utf8",
    );

    const child = spawn(
      process.execPath,
      [
        join(
          process.cwd(),
          "scripts",
          "host-launcher.mjs",
        ),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          JUNIUS_RUNTIME_ROOT: runtimeRoot,
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const [exitCode, signal] = await once(
      child,
      "exit",
    );

    assert.equal(signal, null);
    assert.equal(
      exitCode,
      0,
      stderr,
    );
    assert.match(
      stderr,
      /using validated bootstrap/u,
    );

    await access(markerPath);
    assert.equal(
      await readFile(markerPath, "utf8"),
      "stable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
