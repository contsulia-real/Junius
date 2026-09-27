import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createServer,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function freePort(): Promise<number> {
  const server: Server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHealth(
  origin: string,
  timeoutMs = 15_000,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        origin + "/__junius/host-health",
      );
      if (response.ok) return response;
      lastError = new Error(
        `host_health_status: ${response.status}`,
      );
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, 100),
    );
  }

  throw new Error(
    `host_health_timeout: ${String(lastError)}`,
  );
}

test("Junius Host owns public ports and proxies admin state to its active worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "junius-host-integration-"));
  const mcpPort = await freePort();
  const adminPort = await freePort();
  const hostPath = fileURLToPath(
    new URL("./host.ts", import.meta.url),
  );

  let stderr = "";

  const child = spawn(
    process.execPath,
    ["--import", "tsx", hostPath],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        JUNIUS_MCP_PORT: String(mcpPort),
        JUNIUS_ADMIN_PORT: String(adminPort),
        JUNIUS_WORKSPACE_ID: "host-test",
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
        JUNIUS_WORKER_ROLLBACK_MS: "10000",
      },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    const adminOrigin =
      `http://127.0.0.1:${adminPort}`;

    const health = await waitForHealth(adminOrigin);
    const healthBody = await health.json() as {
      ok: boolean;
      activeWorkerId?: string;
    };

    assert.equal(healthBody.ok, true);
    assert.equal(
      typeof healthBody.activeWorkerId,
      "string",
    );

    const stateResponse = await fetch(adminOrigin + "/state");
    assert.equal(stateResponse.status, 200);

    const state = await stateResponse.json() as {
      machineCapabilities?: unknown[];
      workspaces?: { id: string }[];
    };

    assert.equal(
      Array.isArray(state.machineCapabilities),
      true,
    );
    assert.equal(state.workspaces?.[0]?.id, "host-test");

    const supervisorResponse = await fetch(
      adminOrigin + "/__junius/supervisor",
    );
    assert.equal(supervisorResponse.status, 200);

    const supervisorState = await supervisorResponse.json() as {
      host: { restartRequired: boolean };
      supervisor: { activeWorkerId?: string };
    };

    assert.equal(
      supervisorState.host.restartRequired,
      false,
    );
    assert.equal(
      typeof supervisorState.supervisor.activeWorkerId,
      "string",
    );
  } finally {
    child.kill();

    const exited = await Promise.race([
      once(child, "exit").then(() => true),
      new Promise<boolean>((resolvePromise) =>
        setTimeout(() => resolvePromise(false), 5_000),
      ),
    ]);

    if (!exited) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }

    await rm(root, { recursive: true, force: true });
  }

  assert.equal(
    child.exitCode === 0 || child.signalCode !== null,
    true,
    stderr,
  );
});
