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

test("source-test launcher pins port 18787 and marks the source-test instance", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-dev-launcher-"),
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
  const markerPath = join(
    root,
    "dev-environment.json",
  );

  try {
    await mkdir(
      bootstrapRoot,
      { recursive: true },
    );
    await writeFile(
      stableBootstrapPath,
      `
import { writeFile } from "node:fs/promises";
await writeFile(
  ${JSON.stringify(markerPath)},
  JSON.stringify({
    port: process.env.JUNIUS_MCP_PORT,
    role: process.env.JUNIUS_INSTANCE_ROLE,
  }),
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
        "--dev",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          JUNIUS_RUNTIME_ROOT:
            runtimeRoot,
          JUNIUS_MCP_PORT:
            "9999",
          JUNIUS_INSTANCE_ROLE:
            "production",
        },
        windowsHide: true,
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      },
    );

    let stderr = "";
    child.stderr.setEncoding(
      "utf8",
    );
    child.stderr.on(
      "data",
      (chunk: string) => {
        stderr += chunk;
      },
    );

    const [exitCode, signal] =
      await once(
        child,
        "exit",
      );

    assert.equal(
      signal,
      null,
    );
    assert.equal(
      exitCode,
      0,
      stderr,
    );
    assert.match(
      stderr,
      /Junius source-test instance/u,
    );

    assert.deepEqual(
      JSON.parse(
        await readFile(
          markerPath,
          "utf8",
        ),
      ),
      {
        port: "18787",
        role: "development",
      },
    );
  } finally {
    await rm(
      root,
      {
        recursive: true,
        force: true,
      },
    );
  }
});

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
