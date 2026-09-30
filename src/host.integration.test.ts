import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
): Promise<{
  readonly sessionId:
    string | undefined;
  readonly instructions:
    string | undefined;
}> {
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

  let instructions:
    string | undefined;
  const initialized =
    jsonRpcMessages(body).some(
      (message) => {
        if (
          typeof message !==
            "object" ||
          message === null ||
          !("result" in message)
        ) {
          return false;
        }

        const result = (
          message as {
            result?: {
              instructions?: unknown;
            };
          }
        ).result;
        if (
          typeof result
            ?.instructions ===
          "string"
        ) {
          instructions =
            result.instructions;
        }
        return true;
      },
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

  return {
    sessionId,
    instructions,
  };
}

async function callMcpTool(
  origin: string,
  sessionId: string | undefined,
  name: string,
  args: Record<string, unknown>,
  allowError = false,
): Promise<{
  readonly response: Response;
  readonly payload: Record<string, unknown>;
  readonly isError: boolean;
  readonly textContents:
    readonly string[];
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

    if (!allowError) {
      assert.notEqual(
        result?.isError,
        true,
        body,
      );
    }

    const textContents =
      (result?.content ?? [])
        .filter(
          (
            item,
          ): item is {
            type: string;
            text: string;
          } =>
            item.type === "text" &&
            typeof item.text ===
              "string",
        )
        .map(
          (item) =>
            item.text,
        );

    if (
      textContents[0] !==
      undefined
    ) {
      let payload:
        Record<string, unknown> = {};
      try {
        payload = JSON.parse(
          textContents[0],
        ) as Record<string, unknown>;
      } catch (error) {
        if (!allowError) {
          throw error;
        }
      }

      return {
        response,
        payload,
        isError:
          result?.isError === true,
        textContents,
      };
    }
  }

  throw new Error(
    `mcp_tool_result_missing: ${name}: ${body}`,
  );
}

async function listMcpTools(
  origin: string,
  sessionId: string | undefined,
): Promise<readonly {
  readonly name?: string;
  readonly inputSchema?: {
    readonly required?: readonly string[];
    readonly properties?: Record<
      string,
      {
        readonly enum?: readonly string[];
        readonly const?: unknown;
      }
    >;
  };
}[]> {
  const response = await fetch(
    origin + "/mcp",
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json",
        accept:
          "application/json, text/event-stream",
        ...(sessionId === undefined
          ? {}
          : {
              "mcp-session-id":
                sessionId,
            }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 77,
        method: "tools/list",
        params: {},
      }),
    },
  );
  const body =
    await response.text();
  assert.equal(
    response.status,
    200,
    body,
  );

  for (
    const message of
    jsonRpcMessages(body)
  ) {
    if (
      typeof message !==
        "object" ||
      message === null ||
      !("result" in message)
    ) {
      continue;
    }

    const result = (
      message as {
        result?: {
          tools?: readonly {
            name?: string;
            inputSchema?: {
              required?: readonly string[];
              properties?: Record<
                string,
                {
                  enum?: readonly string[];
                  const?: unknown;
                }
              >;
            };
          }[];
        };
      }
    ).result;

    if (
      Array.isArray(
        result?.tools,
      )
    ) {
      return result.tools;
    }
  }

  throw new Error(
    `mcp_tools_list_missing: ${body}`,
  );
}

test("Junius Host serves MCP and local diagnostics on one loopback listener", async () => {
  const root = await mkdtemp(join(tmpdir(), "junius-host-integration-"));
  const mcpPort = await freePort();
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
    const hostOrigin =
      `http://127.0.0.1:${mcpPort}`;

    const health = await waitForHealth(hostOrigin);
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
      mcpPort,
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
      hostOrigin + "/state",
    );
    assert.equal(
      stateResponse.status,
      404,
    );

    const mcpOrigin =
      hostOrigin;
    const initializedMcp =
      await initializeMcp(
        mcpOrigin,
      );
    const mcpSessionId =
      initializedMcp.sessionId;

    const expectedCoreContract =
      await readFile(
        join(
          process.cwd(),
          "prompts",
          "core.md",
        ),
        "utf8",
      );
    assert.equal(
      initializedMcp
        .instructions,
      expectedCoreContract,
    );

    const tools =
      await listMcpTools(
        mcpOrigin,
        mcpSessionId,
      );
    assert.equal(
      tools.some(
        (tool) =>
          tool.name ===
          "load_junius_contracts",
      ),
      true,
    );
    for (const toolName of [
      "workspace_patch",
      "run_commands",
      "git_snapshot",
      "git_prepare_commit",
      "git_commit",
      "check_junius_update",
      "update_junius",
    ]) {
      assert.equal(
        tools.some(
          (tool) =>
            tool.name ===
            toolName,
        ),
        true,
        `missing MCP tool: ${toolName}`,
      );
    }

    const loadedContracts =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "load_junius_contracts",
        {
          modes: [
            "engineering",
            "desktop",
            "browser",
          ],
        },
      );
    const contractResults =
      loadedContracts.payload
        .contracts as
        | {
            mode?: unknown;
            digest?: unknown;
            text?: unknown;
          }[]
        | undefined;
    assert.deepEqual(
      contractResults?.map(
        (contract) =>
          contract.mode,
      ),
      [
        "engineering",
        "desktop",
        "browser",
      ],
    );
    for (
      const contract of
      contractResults ?? []
    ) {
      assert.match(
        String(
          contract.digest,
        ),
        /^[a-f0-9]{64}$/u,
      );
    }

    assert.equal(
      loadedContracts
        .textContents.length,
      4,
    );
    const expectedSpecializedContracts =
      await Promise.all(
        [
          "engineering.md",
          "desktop.md",
          "browser.md",
        ].map(
          (file) =>
            readFile(
              join(
                process.cwd(),
                "prompts",
                file,
              ),
              "utf8",
            ),
        ),
      );
    assert.deepEqual(
      loadedContracts
        .textContents
        .slice(1),
      expectedSpecializedContracts,
    );

    const browserTool =
      tools.find(
        (tool) =>
          tool.name ===
          "playwright_cli",
      );
    const browserProperties =
      browserTool?.inputSchema
        ?.properties ?? {};
    assert.equal(
      browserProperties
        .explicit_user_authorization
        ?.const,
      true,
    );
    assert.equal(
      browserTool
        ?.inputSchema
        ?.required
        ?.includes(
          "explicit_user_authorization",
        ) ?? false,
      false,
    );

    const unauthorizedBrowser =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "playwright_cli",
        {
          session:
            "browser-privacy-boundary",
          command:
            "snapshot",
          args: [],
        },
        true,
      );
    assert.equal(
      unauthorizedBrowser
        .isError,
      true,
    );
    assert.match(
      unauthorizedBrowser
        .textContents
        .join("\n"),
      /authorization_required/u,
    );

    const desktopTool =
      tools.find(
        (tool) =>
          tool.name ===
          "desktop",
      );
    assert.notEqual(
      desktopTool,
      undefined,
    );
    const desktopProperties =
      desktopTool
        ?.inputSchema
        ?.properties ?? {};
    const desktopCommands =
      desktopProperties
        .command
        ?.enum ?? [];
    for (
      const command of [
        "action_batch",
        "drag",
        "wait",
      ]
    ) {
      assert.equal(
        desktopCommands.includes(
          command,
        ),
        true,
        `Desktop schema missing command: ${command}`,
      );
    }
    assert.equal(
      desktopTool
        ?.inputSchema
        ?.required
        ?.includes(
          "explicit_user_authorization",
        ) ?? false,
      false,
      "Desktop authorization assertion must be optional globally and required by control_begin semantics only.",
    );
    assert.equal(
      desktopProperties
        .explicit_user_authorization
        ?.const,
      true,
    );

    const unauthorizedDesktop =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "desktop",
        {
          session:
            "privacy-boundary",
          command:
            "control_begin",
        },
        true,
      );
    assert.equal(
      unauthorizedDesktop.isError,
      true,
    );
    assert.match(
      unauthorizedDesktop
        .textContents
        .join("\n"),
      /authorization_required/u,
    );

    const unauthorizedScreenshot =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "desktop",
        {
          session:
            "privacy-boundary",
          command:
            "screenshot",
        },
        true,
      );
    assert.equal(
      unauthorizedScreenshot
        .isError,
      true,
    );
    assert.match(
      unauthorizedScreenshot
        .textContents
        .join("\n"),
      /authorization_required/u,
    );

    for (
      const property of [
        "explicit_user_authorization",
        "actions",
        "screenshot_after",
        "screenshot_handle",
        "to_x",
        "to_y",
        "duration_ms",
      ]
    ) {
      assert.equal(
        property in
          desktopProperties,
        true,
        `Desktop schema missing property: ${property}`,
      );
    }

    const secondWorkspaceRoot = join(
      root,
      "second-workspace",
    );
    await mkdir(
      secondWorkspaceRoot,
      { recursive: true },
    );
    await writeFile(
      join(
        secondWorkspaceRoot,
        "AGENTS.md",
      ),
      "MCP black-box instruction\n",
      "utf8",
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

    const blockedWrite =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "write",
        {
          workspace: "second",
          files: [
            {
              path: "probe.txt",
              content:
                "blocked\n",
            },
          ],
        },
        true,
      );
    assert.equal(
      blockedWrite.isError,
      true,
    );
    assert.equal(
      blockedWrite.payload.code,
      "agents_ack_required",
    );
    const agentsDetails =
      blockedWrite.payload
        .details as {
          agentsDigest?: unknown;
          agentInstructions?: {
            path?: unknown;
            scope?: unknown;
            content?: unknown;
          }[];
        } | undefined;
    assert.equal(
      typeof agentsDetails
        ?.agentsDigest,
      "string",
    );
    assert.match(
      agentsDetails
        ?.agentsDigest as string,
      /^[a-f0-9]{64}$/u,
    );
    assert.deepEqual(
      agentsDetails
        ?.agentInstructions,
      [
        {
          path:
            "AGENTS.md",
          scope: ".",
          depth: 0,
          content:
            "MCP black-box instruction\n",
        },
      ],
    );
    await assert.rejects(
      readFile(
        join(
          secondWorkspaceRoot,
          "probe.txt",
        ),
        "utf8",
      ),
      (
        error: unknown,
      ) =>
        typeof error ===
          "object" &&
        error !== null &&
        "code" in error &&
        error.code ===
          "ENOENT",
    );

    const acknowledgedWrite =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "write",
        {
          workspace: "second",
          agents_digest:
            agentsDetails
              ?.agentsDigest,
          files: [
            {
              path: "probe.txt",
              content:
                "allowed\n",
            },
          ],
        },
      );
    assert.equal(
      acknowledgedWrite
        .payload.ok,
      true,
    );
    assert.equal(
      await readFile(
        join(
          secondWorkspaceRoot,
          "probe.txt",
        ),
        "utf8",
      ),
      "allowed\n",
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
      hostOrigin + "/__junius/supervisor",
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
