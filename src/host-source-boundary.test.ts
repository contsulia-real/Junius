import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hostSourceDependencies,
  sourceChangeDisposition,
} from "./host-source-boundary.js";

test("host source boundary follows transitive relative imports", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-host-boundary-"),
  );

  try {
    await writeFile(
      join(root, "host.ts"),
      [
        'import "./reverse-proxy.js";',
        'import "./host-source-boundary.js";',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, "reverse-proxy.ts"),
      'import "./worker-auth.js";\n',
      "utf8",
    );
    await writeFile(
      join(root, "worker-auth.ts"),
      "export const token = 1;\n",
      "utf8",
    );
    await writeFile(
      join(root, "host-source-boundary.ts"),
      "export const boundary = true;\n",
      "utf8",
    );
    await writeFile(
      join(root, "worker-only.ts"),
      "export const worker = true;\n",
      "utf8",
    );

    const dependencies =
      hostSourceDependencies(root);

    assert.deepEqual(
      [...dependencies].sort(),
      [
        "host-source-boundary.ts",
        "host.ts",
        "reverse-proxy.ts",
        "worker-auth.ts",
      ],
    );

    assert.equal(
      sourceChangeDisposition(
        root,
        "src",
        "worker-auth.ts",
      ),
      "restart-host",
    );
    assert.equal(
      sourceChangeDisposition(
        root,
        "src",
        "worker-only.ts",
      ),
      "reload-worker",
    );
    assert.equal(
      sourceChangeDisposition(
        root,
        "src",
        "worker-only.test.ts",
      ),
      "ignore",
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("host source boundary treats startup control files as restart-only", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-host-controls-"),
  );

  try {
    await writeFile(
      join(root, "host.ts"),
      "export {};\n",
      "utf8",
    );

    for (const file of [
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.json",
    ]) {
      assert.equal(
        sourceChangeDisposition(
          root,
          "root",
          file,
        ),
        "restart-host",
      );
    }

    for (const file of [
      "host-bootstrap.mjs",
      "host-launcher.mjs",
    ]) {
      assert.equal(
        sourceChangeDisposition(
          root,
          "scripts",
          file,
        ),
        "restart-host",
      );
    }

    assert.equal(
      sourceChangeDisposition(
        root,
        "root",
        "README.md",
      ),
      "ignore",
    );
    assert.equal(
      sourceChangeDisposition(
        root,
        "python",
        "desktop_helper.py",
      ),
      "reload-worker",
    );
    assert.equal(
      sourceChangeDisposition(
        root,
        "src",
        undefined,
      ),
      "restart-host",
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
