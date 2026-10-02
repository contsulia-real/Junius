import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildRuntime,
} from "./build-runtime.mjs";

test("release runtime emits plain JavaScript Host and Worker entries with required runtime assets", async () => {
  const root = await mkdtemp(
    join(
      tmpdir(),
      "junius-runtime-build-",
    ),
  );

  try {
    await buildRuntime({
      outputRoot: root,
    });

    for (const path of [
      "src/host.js",
      "src/worker-entry.js",
      "src/job-bootstrap.mjs",
      "src/windows-job-guardian.ps1",
      "python/desktop_helper.py",
      "prompts/core.md",
      "scripts/install-paths.mjs",
      "scripts/install-process.mjs",
      "scripts/update.mjs",
      "scripts/windows-only.mjs",
      "package.json",
    ]) {
      await access(
        join(root, path),
      );
    }

    const host = await readFile(
      join(
        root,
        "src",
        "host.js",
      ),
      "utf8",
    );
    assert.doesNotMatch(
      host,
      /--import["',\s]+tsx/u,
    );

    const runtimePackage =
      JSON.parse(
        await readFile(
          join(
            root,
            "package.json",
          ),
          "utf8",
        ),
      );
    assert.equal(
      runtimePackage.devDependencies,
      undefined,
    );
    assert.equal(
      runtimePackage.dependencies,
      undefined,
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
