import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawnManagedWorker } from "./worker-process.js";

test("spawnManagedWorker starts an isolated healthy Junius worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "junius-worker-process-"));

  try {
    const worker = await spawnManagedWorker({
      workerEntryPath: fileURLToPath(
        new URL("./worker-entry.ts", import.meta.url),
      ),
      cwd: process.cwd(),
      publicMcpOrigin: "http://127.0.0.1:48787",
      publicAdminOrigin: "http://127.0.0.1:48788",
      environment: {
        ...process.env,
        JUNIUS_WORKSPACE_ID: "worker-test",
        JUNIUS_WORKSPACE_ROOT: root,
        JUNIUS_WORKSPACE_STATE_PATH: join(
          root,
          "workspace-state.json",
        ),
        JUNIUS_MACHINE_CAPABILITY_STATE_PATH: join(
          root,
          "machine-capability-state.json",
        ),
        JUNIUS_BROWSER_STATE_PATH: join(root, "browser"),
      },
    });

    try {
      assert.equal(worker.exited(), false);
      assert.equal(worker.pid > 0, true);
      assert.equal(worker.mcpPort > 0, true);
      assert.equal(worker.adminPort > 0, true);

      const health = await fetch(
        `http://127.0.0.1:${worker.adminPort}/__junius/worker-health`,
      );
      assert.equal(health.status, 200);
      assert.deepEqual(
        await health.json(),
        {
          ok: true,
          workerId: worker.id,
          pid: worker.pid,
        },
      );
    } finally {
      await worker.close();
    }

    assert.equal(worker.exited(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
