import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
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

async function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{
  readonly statusCode: number;
  readonly body: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => {
          chunks.push(
            Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk),
          );
        });
        res.once("end", () => {
          resolvePromise({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    req.once("error", reject);
    req.end();
  });
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

test("Junius Host exposes MCP plus private health and supervisor control without a public management UI", async () => {
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

    const hostileHost = await rawRequest(
      adminPort,
      "/__junius/host-health",
      {
        Host: "example.invalid",
      },
    );
    assert.equal(hostileHost.statusCode, 403);
    assert.equal(
      (JSON.parse(hostileHost.body) as {
        error: string;
      }).error,
      "host_not_allowed",
    );

    const hostileOrigin = await fetch(
      `http://127.0.0.1:${mcpPort}/mcp`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://example.invalid",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: {
            name: "list_workspaces",
            arguments: {},
          },
        }),
      },
    );
    assert.equal(hostileOrigin.status, 403);
    assert.equal(
      (
        await hostileOrigin.json() as {
          error: string;
        }
      ).error,
      "origin_not_allowed",
    );

    const stateResponse = await fetch(
      adminOrigin + "/state",
    );
    assert.equal(
      stateResponse.status,
      404,
    );

    const mcpResponse = await fetch(
      `http://127.0.0.1:${mcpPort}/mcp`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "list_workspaces",
            arguments: {},
          },
        }),
      },
    );
    await mcpResponse.text();
    assert.equal(
      typeof mcpResponse.headers.get("x-junius-trace-id"),
      "string",
    );

    const supervisorResponse = await fetch(
      adminOrigin + "/__junius/supervisor",
    );
    assert.equal(supervisorResponse.status, 200);

    const supervisorState = await supervisorResponse.json() as {
      host: { restartRequired: boolean };
      supervisor: { activeWorkerId?: string };
      latencyTraces?: {
        tool?: string;
        statusCode: number;
        workerDurationMs?: number;
        hostTotalMs: number;
        proxyOverheadMs?: number;
      }[];
    };

    assert.equal(
      supervisorState.host.restartRequired,
      false,
    );
    assert.equal(
      typeof supervisorState.supervisor.activeWorkerId,
      "string",
    );
    assert.equal(
      supervisorState.latencyTraces?.[0]?.tool,
      "list_workspaces",
    );
    assert.equal(
      supervisorState.latencyTraces?.[0]?.statusCode,
      mcpResponse.status,
    );
    assert.equal(
      typeof supervisorState.latencyTraces?.[0]
        ?.workerDurationMs,
      "number",
    );
    assert.equal(
      typeof supervisorState.latencyTraces?.[0]
        ?.hostTotalMs,
      "number",
    );
    assert.equal(
      typeof supervisorState.latencyTraces?.[0]
        ?.proxyOverheadMs,
      "number",
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
