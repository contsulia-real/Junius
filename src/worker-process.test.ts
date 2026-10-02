import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WORKER_AUTH_HEADER } from "./worker-auth.js";
import { spawnManagedWorker } from "./worker-process.js";
import { windowsProcessOwnsConsole } from "./windows-console.test-helper.js";

test("spawnManagedWorker ignores startup IPC for another worker id", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-worker-ipc-"),
  );
  const entry = join(root, "worker.mjs");

  try {
    await writeFile(
      entry,
      `
import { createServer } from "node:http";

const workerId = process.env.JUNIUS_WORKER_ID;
const control = createServer((req, res) => {
  if (req.url === "/__junius/worker-health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      workerId,
      pid: process.pid,
    }));
    return;
  }
  res.statusCode = 404;
  res.end();
});
const mcp = createServer((_req, res) => res.end("ok"));

await Promise.all([
  new Promise((resolve) => control.listen(0, "127.0.0.1", resolve)),
  new Promise((resolve) => mcp.listen(0, "127.0.0.1", resolve)),
]);

process.send?.({
  type: "junius-worker-startup-error",
  workerId: "wrong-worker-id",
  message: "must be ignored",
});
process.send?.({
  type: "junius-worker-ready",
  workerId,
  pid: process.pid,
  mcpPort: mcp.address().port,
  controlPort: control.address().port,
});

process.on("message", (message) => {
  if (message?.type !== "junius-worker-shutdown") return;
  Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => mcp.close(resolve)),
  ]).finally(() => process.exit(0));
});
`,
      "utf8",
    );

    const worker = await spawnManagedWorker({
      workerEntryPath: entry,
      cwd: root,
      publicMcpOrigin: "http://127.0.0.1:48787",
      
      startupTimeoutMs: 2_000,
    });

    try {
      assert.equal(worker.exited(), false);
      assert.equal(worker.pid > 0, true);
      assert.equal(
        worker.child.spawnargs.includes("tsx"),
        false,
        "plain JavaScript workers must not load tsx/esbuild",
      );
    } finally {
      await worker.close();
    }
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("spawnManagedWorker rejects a ready message with the wrong pid", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-worker-bad-pid-"),
  );
  const entry = join(root, "worker.mjs");

  try {
    await writeFile(
      entry,
      `
process.send?.({
  type: "junius-worker-ready",
  workerId: process.env.JUNIUS_WORKER_ID,
  pid: process.pid + 1,
  mcpPort: 40101,
  controlPort: 40102,
});
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    await assert.rejects(
      spawnManagedWorker({
        workerEntryPath: entry,
        cwd: root,
        publicMcpOrigin: "http://127.0.0.1:48787",
        
        startupTimeoutMs: 2_000,
        execArgv: [],
      }),
      /worker_ready_pid_mismatch/u,
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("spawnManagedWorker starts an isolated healthy Junius worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "junius-worker-process-"));

  try {
    const worker = await spawnManagedWorker({
      workerEntryPath: fileURLToPath(
        new URL("./worker-entry.ts", import.meta.url),
      ),
      cwd: process.cwd(),
      publicMcpOrigin: "http://127.0.0.1:48787",
      
      environment: {
        ...process.env,
        JUNIUS_INSTANCE_ROLE:
          "installed",
        JUNIUS_WORKSPACE_ID: "worker-test",
        JUNIUS_WORKSPACE_ROOT: root,
        JUNIUS_WORKSPACE_STATE_PATH: join(
          root,
          "workspace-state.json",
        ),
        JUNIUS_BROWSER_STATE_PATH: join(root, "browser"),
      },
    });

    try {
      assert.equal(worker.exited(), false);
      assert.equal(worker.pid > 0, true);
      assert.equal(worker.mcpPort > 0, true);
      assert.equal(worker.controlPort > 0, true);

      if (process.platform === "win32") {
        assert.equal(
          await windowsProcessOwnsConsole(worker.pid),
          false,
        );
      }

      const privateHealthUrl =
        `http://127.0.0.1:${worker.controlPort}/__junius/worker-health`;

      const unauthenticatedHealth =
        await fetch(privateHealthUrl);
      assert.equal(
        unauthenticatedHealth.status,
        403,
      );
      assert.deepEqual(
        await unauthenticatedHealth.json(),
        {
          error: "worker_auth_required",
        },
      );

      const health = await fetch(
        privateHealthUrl,
        {
          headers: {
            [WORKER_AUTH_HEADER]:
              worker.internalToken,
          },
        },
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

      const unauthenticatedMcp = await fetch(
        `http://127.0.0.1:${worker.mcpPort}/not-mcp`,
      );
      assert.equal(
        unauthenticatedMcp.status,
        403,
      );

      const authenticatedMcp = await fetch(
        `http://127.0.0.1:${worker.mcpPort}/not-mcp`,
        {
          headers: {
            [WORKER_AUTH_HEADER]:
              worker.internalToken,
          },
        },
      );
      assert.equal(authenticatedMcp.status, 404);
    } finally {
      await worker.close();
    }

    assert.equal(worker.exited(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
