import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function runValidationCommand(
  runtimeRoot: string,
  transaction: string,
  command: "begin" | "commit",
): Promise<void> {
  const script = join(
    process.cwd(),
    "scripts",
    "source-validation.mjs",
  );
  const child = spawn(
    process.execPath,
    [script, command],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        JUNIUS_RUNTIME_ROOT:
          runtimeRoot,
        JUNIUS_SOURCE_VALIDATION_TRANSACTION:
          transaction,
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
  child.stderr.on(
    "data",
    (chunk: Buffer | string) => {
      stderr += chunk.toString();
    },
  );

  const [exitCode] =
    await once(child, "exit");

  assert.equal(
    exitCode,
    0,
    stderr,
  );
}

test("source validation ignores generated Python bytecode", async () => {
  const root = await mkdtemp(
    join(
      tmpdir(),
      "junius-source-validation-pycache-",
    ),
  );
  const runtimeRoot = join(
    root,
    "runtime",
  );
  const pycacheRoot = join(
    process.cwd(),
    "python",
    "__pycache__",
  );
  const bytecodePath = join(
    pycacheRoot,
    "release-audit-test.pyc",
  );

  try {
    await mkdir(
      pycacheRoot,
      { recursive: true },
    );
    await runValidationCommand(
      runtimeRoot,
      "pycache",
      "begin",
    );
    await writeFile(
      bytecodePath,
      Buffer.from([
        0,
        1,
        2,
        3,
      ]),
    );
    await runValidationCommand(
      runtimeRoot,
      "pycache",
      "commit",
    );
  } finally {
    await rm(
      bytecodePath,
      { force: true },
    );
    await rm(
      root,
      {
        recursive: true,
        force: true,
      },
    );
  }
});

test("source validation keeps concurrent pending transactions independent", async () => {
  const root = await mkdtemp(
    join(
      tmpdir(),
      "junius-source-validation-",
    ),
  );
  const runtimeRoot = join(
    root,
    "runtime",
  );
  const pendingRoot = join(
    runtimeRoot,
    "source-validation.pending",
  );

  try {
    await runValidationCommand(
      runtimeRoot,
      "validation-a",
      "begin",
    );
    await runValidationCommand(
      runtimeRoot,
      "validation-b",
      "begin",
    );

    assert.deepEqual(
      (
        await readdir(
          pendingRoot,
        )
      ).sort(),
      [
        "validation-a.json",
        "validation-b.json",
      ],
    );

    await runValidationCommand(
      runtimeRoot,
      "validation-a",
      "commit",
    );

    assert.deepEqual(
      await readdir(
        pendingRoot,
      ),
      ["validation-b.json"],
    );

    await runValidationCommand(
      runtimeRoot,
      "validation-b",
      "commit",
    );

    assert.deepEqual(
      await readdir(
        pendingRoot,
      ),
      [],
    );

    const validated =
      JSON.parse(
        await readFile(
          join(
            runtimeRoot,
            "source-validation.json",
          ),
          "utf8",
        ),
      ) as {
        fingerprint?: unknown;
        validatedAt?: unknown;
      };

    assert.equal(
      typeof validated.fingerprint,
      "string",
    );
    assert.equal(
      typeof validated.validatedAt,
      "string",
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
