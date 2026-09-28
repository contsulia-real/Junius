import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

function jsonRpcMessages(
  body: string,
): readonly unknown[] {
  try {
    return [JSON.parse(body) as unknown];
  } catch {
    const messages: unknown[] = [];
    for (const line of body.split(/\r?\n/u)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      messages.push(
        JSON.parse(payload) as unknown,
      );
    }
    return messages;
  }
}

async function initializeMcp(
  origin: string,
): Promise<string | undefined> {
  const response = await fetch(
    origin + "/mcp",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: {
            name: "junius-integration-test",
            version: "1",
          },
        },
      }),
    },
  );
  const body = await response.text();
  assert.equal(response.status, 200, body);

  const initialized = jsonRpcMessages(body).some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "result" in message,
  );
  assert.equal(initialized, true, body);

  const sessionId =
    response.headers.get("mcp-session-id") ??
    undefined;
  const notification = await fetch(
    origin + "/mcp",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId === undefined
          ? {}
          : {
              "mcp-session-id": sessionId,
            }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    },
  );
  const notificationBody =
    await notification.text();
  assert.equal(
    notification.status === 200 ||
      notification.status === 202,
    true,
    notificationBody,
  );

  return sessionId;
}

async function callMcpTool(
  origin: string,
  sessionId: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<{
  readonly response: Response;
  readonly payload: Record<string, unknown>;
}> {
  const response = await fetch(
    origin + "/mcp",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId === undefined
          ? {}
          : {
              "mcp-session-id": sessionId,
            }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name,
          arguments: args,
        },
      }),
    },
  );
  const body = await response.text();
  assert.equal(response.status, 200, body);

  for (const message of jsonRpcMessages(body)) {
    if (
      typeof message !== "object" ||
      message === null ||
      !("result" in message)
    ) {
      continue;
    }

    const result = (
      message as {
        result?: {
          isError?: boolean;
          content?: {
            type?: string;
            text?: string;
          }[];
        };
      }
    ).result;

    assert.notEqual(
      result?.isError,
      true,
      body,
    );

    for (const item of result?.content ?? []) {
      if (
        item.type !== "text" ||
        typeof item.text !== "string"
      ) {
        continue;
      }

      return {
        response,
        payload: JSON.parse(
          item.text,
        ) as Record<string, unknown>,
      };
    }
  }

  throw new Error(
    `mcp_tool_result_missing: ${name}: ${body}`,
  );
}

test("Junius Host exposes MCP plus private health and supervisor control without a public management UI", async () => {
  const root = await mkdtemp(join(tmpdir(), "junius-host-integration-"));
  const mcpPort = await freePort();
  const controlPort = await freePort();
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
        JUNIUS_CONTROL_PORT: String(controlPort),
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
    const controlOrigin =
      `http://127.0.0.1:${controlPort}`;

    const health = await waitForHealth(controlOrigin);
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
      controlPort,
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
      controlOrigin + "/state",
    );
    assert.equal(
      stateResponse.status,
      404,
    );

    const mcpOrigin =
      `http://127.0.0.1:${mcpPort}`;
    const mcpSessionId =
      await initializeMcp(
        mcpOrigin,
      );

    const secondWorkspaceRoot = join(
      root,
      "second-workspace",
    );
    await mkdir(
      secondWorkspaceRoot,
      { recursive: true },
    );

    const created = await callMcpTool(
      mcpOrigin,
      mcpSessionId,
      "create_workspace",
      {
        id: "second",
        root_path: secondWorkspaceRoot,
      },
    );
    assert.equal(
      (
        created.payload.workspace as {
          id?: unknown;
        } | undefined
      )?.id,
      "second",
    );

    const command = await callMcpTool(
      mcpOrigin,
      mcpSessionId,
      "run_command",
      {
        workspace: "second",
        executable: process.execPath,
        args: [
          "-e",
          "process.stdout.write('unrestricted-command-ok')",
        ],
      },
    );
    assert.equal(
      (
        command.payload.execution as {
          stdout?: unknown;
        } | undefined
      )?.stdout,
      "unrestricted-command-ok",
    );

    const listed = await callMcpTool(
      mcpOrigin,
      mcpSessionId,
      "list_workspaces",
      {},
    );
    assert.equal(
      (
        listed.payload.workspaces as {
          id?: unknown;
        }[] | undefined
      )?.some(
        (workspace) =>
          workspace.id === "second",
      ),
      true,
    );

    const deleted = await callMcpTool(
      mcpOrigin,
      mcpSessionId,
      "delete_workspace",
      {
        id: "second",
      },
    );
    assert.equal(
      (
        deleted.payload.workspace as {
          id?: unknown;
        } | undefined
      )?.id,
      "second",
    );

    const afterDelete = await callMcpTool(
      mcpOrigin,
      mcpSessionId,
      "list_workspaces",
      {},
    );
    assert.equal(
      (
        afterDelete.payload.workspaces as {
          id?: unknown;
        }[] | undefined
      )?.some(
        (workspace) =>
          workspace.id === "second",
      ),
      false,
    );

    const tracedList = await callMcpTool(
      mcpOrigin,
      mcpSessionId,
      "list_workspaces",
      {},
    );
    const mcpResponse =
      tracedList.response;
    assert.equal(
      typeof mcpResponse.headers.get("x-junius-trace-id"),
      "string",
    );

    const supervisorResponse = await fetch(
      controlOrigin + "/__junius/supervisor",
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
