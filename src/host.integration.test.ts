import assert from "node:assert/strict";
import {
  createHash,
} from "node:crypto";
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
  readdir,
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
          structuredContent?:
            Record<string, unknown>;
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
        )
        .filter(
          (value) =>
            !value.startsWith(
              "[Junius internal]",
            ),
        );

    let payload:
      Record<string, unknown> =
        result?.structuredContent ?? {};

    if (
      textContents[0] !==
      undefined
    ) {
      try {
        payload = JSON.parse(
          textContents[0],
        ) as Record<string, unknown>;
      } catch (error) {
        if (
          result?.structuredContent ===
            undefined &&
          !allowError
        ) {
          throw error;
        }
      }
    }

    if (
      textContents.length > 0 ||
      result?.structuredContent !==
        undefined
    ) {
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
        JUNIUS_WORKER_ENTRY_PATH: "",
        JUNIUS_PROJECT_ROOT: process.cwd(),
        JUNIUS_MCP_PORT: String(mcpPort),
        LOCALAPPDATA: join(
          root,
          "local-app-data",
        ),
        USERPROFILE: join(
          root,
          "user-profile",
        ),
        JUNIUS_WORKSPACE_ID: "host-test",
        JUNIUS_WORKSPACE_ROOT: root,
        JUNIUS_WORKSPACE_STATE_PATH: join(
          root,
          "workspace-state.json",
        ),
        JUNIUS_BROWSER_STATE_PATH: join(root, "browser"),
        JUNIUS_RUNTIME_ROOT: join(root, "runtime"),
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
      initializedMcp.instructions?.replaceAll("\r\n", "\n"),
      expectedCoreContract.replaceAll("\r\n", "\n"),
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
      "write_file",
      "apply_patch",
      "delete_file",
      "move_file",
      "copy_file",
      "mkdir",
      "workspace_mutate",
      "run_commands",
      "git_snapshot",
      "git_prepare_commit",
      "git_commit",
      "check_junius_update",
      "update_junius",
      "get_junius_prompts",
      "set_junius_prompt",
      "reset_junius_prompt",
      "list_skills",
      "read_skill",
      "install_skill",
      "remove_skill",
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

    for (const removedTool of [
      "write",
      "workspace_apply",
      "workspace_patch",
    ]) {
      assert.equal(
        tools.some(
          (tool) =>
            tool.name ===
            removedTool,
        ),
        false,
        `stale MCP tool still exposed: ${removedTool}`,
      );
    }

    const sourceSkillRoot =
      join(
        root,
        "source-skill",
      );
    await mkdir(
      sourceSkillRoot,
      { recursive: true },
    );
    await writeFile(
      join(
        sourceSkillRoot,
        "SKILL.md",
      ),
      [
        "---",
        "name: host-skill",
        "description: Host integration skill",
        "---",
        "",
        "# Host Skill",
        "",
      ].join("\n"),
      "utf8",
    );

    const begunTurn =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "junius_turn_begin",
        {
          parts: [
            {
              type: "text",
              text:
                "Exercise the Host MCP integration surface.",
            },
          ],
        },
        true,
      );
    assert.equal(
      begunTurn.isError,
      false,
    );

    const unreviewedMutation =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "run_command",
        {
          workspace: "default",
          executable: "node",
          args: ["--version"],
        },
        true,
      );
    assert.equal(unreviewedMutation.isError, true);
    assert.match(
      unreviewedMutation.textContents.join(" "),
      /junius_task_review/u,
    );

    const unreviewedRead =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "list_skills",
        {},
      );
    assert.equal(unreviewedRead.isError, false);

    const reviewedTurn =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "junius_task_review",
        {
          objective: "Exercise the full Host MCP integration surface",
          scope: "Only the synthetic integration sandbox and registered test tools",
          risks: "Confirm writes, permissions and session isolation do not leak",
          verification: "Check tool effects and the MCP result contract",
        },
      );
    assert.equal(reviewedTurn.isError, false);

    const installedSkill =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "install_skill",
        {
          source:
            sourceSkillRoot,
          scope: "global",
        },
      );
    assert.equal(
      (installedSkill.payload
        .installed as {
          name?: unknown;
        } | undefined)?.name,
      "host-skill",
    );

    const listedSkills =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "list_skills",
        {},
      );
    const skillRows =
      listedSkills.payload
        .skills as
        | {
            name?: unknown;
            scope?: unknown;
            effective?: unknown;
          }[]
        | undefined;
    assert.equal(
      skillRows?.some(
        (skill) =>
          skill.name ===
            "host-skill" &&
          skill.scope ===
            "global" &&
          skill.effective ===
            true,
      ),
      true,
    );

    const readSkill =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "read_skill",
        {
          name: "host-skill",
        },
      );
    assert.equal(
      (readSkill.payload.skill as {
        scope?: unknown;
      } | undefined)?.scope,
      "global",
    );

    const installedWorkspaceSkill =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "install_skill",
        {
          source:
            sourceSkillRoot,
          scope: "workspace",
          workspace:
            "host-test",
        },
      );
    assert.equal(
      (installedWorkspaceSkill.payload
        .installed as {
          scope?: unknown;
        } | undefined)?.scope,
      "workspace",
    );

    const listedWorkspaceSkills =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "list_skills",
        {
          workspace:
            "host-test",
        },
      );
    const workspaceSkillRows =
      listedWorkspaceSkills.payload
        .skills as
        | {
            name?: unknown;
            scope?: unknown;
            effective?: unknown;
          }[]
        | undefined;
    assert.equal(
      workspaceSkillRows?.filter(
        (skill) =>
          skill.name ===
          "host-skill",
      ).length,
      2,
    );
    assert.equal(
      workspaceSkillRows?.find(
        (skill) =>
          skill.scope ===
          "workspace",
      )?.effective,
      true,
    );
    assert.equal(
      workspaceSkillRows?.find(
        (skill) =>
          skill.scope ===
          "global",
      )?.effective,
      false,
    );

    const readEffectiveWorkspaceSkill =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "read_skill",
        {
          name: "host-skill",
          workspace:
            "host-test",
        },
      );
    assert.equal(
      (readEffectiveWorkspaceSkill
        .payload.skill as {
          scope?: unknown;
        } | undefined)?.scope,
      "workspace",
    );

    const removedWorkspaceSkill =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "remove_skill",
        {
          name: "host-skill",
          scope: "workspace",
          workspace:
            "host-test",
        },
      );
    assert.equal(
      (removedWorkspaceSkill.payload
        .effectiveAfter as {
          scope?: unknown;
        } | undefined)?.scope,
      "global",
    );

    const removedSkill =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "remove_skill",
        {
          name: "host-skill",
          scope: "global",
        },
      );
    assert.equal(
      (removedSkill.payload
        .removed as {
          name?: unknown;
        } | undefined)?.name,
      "host-skill",
    );

    const customEngineering =
      "# custom engineering from MCP\n";
    const setPrompt =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "set_junius_prompt",
        {
          prompt:
            "engineering",
          content:
            customEngineering,
        },
      );
    assert.equal(
      setPrompt.payload
        .source,
      "custom",
    );

    const getPrompts =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "get_junius_prompts",
        {
          prompts: [
            "engineering",
          ],
        },
      );
    const promptRows =
      getPrompts.payload
        .prompts as
        | {
            prompt?: unknown;
            source?: unknown;
            content?: unknown;
          }[]
        | undefined;
    assert.deepEqual(
      promptRows,
      [
        {
          prompt:
            "engineering",
          source:
            "custom",
          path:
            join(
              root,
              "local-app-data",
              "Junius",
              "prompts",
              "engineering.md",
            ),
          digest:
            createHash(
              "sha256",
            )
              .update(
                customEngineering,
                "utf8",
              )
              .digest(
                "hex",
              ),
          content:
            customEngineering,
        },
      ],
    );

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
            file ===
            "engineering.md"
              ? Promise.resolve(
                  customEngineering,
                )
              : readFile(
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
      loadedContracts.textContents.slice(1).map(value => value.replaceAll("\r\n", "\n")),
      expectedSpecializedContracts.map(value => value.replaceAll("\r\n", "\n")),
    );

    await callMcpTool(
      mcpOrigin,
      mcpSessionId,
      "reset_junius_prompt",
      {
        prompt:
          "engineering",
      },
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
    assert.equal("explicit_user_authorization" in browserProperties, false);
    assert.equal("purpose" in browserProperties, false);
    assert.equal(
      browserTool
        ?.inputSchema
        ?.required
        ?.includes(
          "explicit_user_authorization",
        ) ?? false,
      false,
    );

    assert.equal(tools.some(tool => tool.name === "junius_computer_permission_request"), false);
    assert.equal(tools.some(tool => tool.name === "junius_computer_permission_decide"), false);

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
      "Desktop has no Junius-specific permission inputs.",
    );
    assert.equal("explicit_user_authorization" in desktopProperties, false);
    assert.equal("purpose" in desktopProperties, false);

    // Live Browser/Desktop access is tested only through synthetic helpers.
    // Host contract checks must never operate the user's actual device.

    for (
      const property of [
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
        "write_file",
        {
          workspace: "second",
          path: "probe.txt",
          content:
            "blocked\n",
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
        "write_file",
        {
          workspace: "second",
          agents_digest:
            agentsDetails
              ?.agentsDigest,
          path: "probe.txt",
          content:
            "allowed\n",
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


    const patched = await callMcpTool(
      mcpOrigin,
      mcpSessionId,
      "apply_patch",
      {
        workspace: "second",
        agents_digest:
          agentsDetails
            ?.agentsDigest,
        patch: [
          "--- a/probe.txt",
          "+++ b/probe.txt",
          "@@ -1,1 +1,1 @@",
          "-allowed",
          "+patched",
          "",
        ].join("\n"),
      },
    );
    assert.equal(
      patched.payload.ok,
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
      "patched\n",
    );

    const madeDirectory =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "mkdir",
        {
          workspace: "second",
          agents_digest:
            agentsDetails
              ?.agentsDigest,
          path: "nested",
        },
      );
    assert.equal(
      madeDirectory.payload.ok,
      true,
    );

    const copied = await callMcpTool(
      mcpOrigin,
      mcpSessionId,
      "copy_file",
      {
        workspace: "second",
        agents_digest:
          agentsDetails
            ?.agentsDigest,
        source: "probe.txt",
        destination:
          "nested/copied.txt",
      },
    );
    assert.equal(
      copied.payload.ok,
      true,
    );

    const moved = await callMcpTool(
      mcpOrigin,
      mcpSessionId,
      "move_file",
      {
        workspace: "second",
        agents_digest:
          agentsDetails
            ?.agentsDigest,
        source:
          "nested/copied.txt",
        destination:
          "nested/moved.txt",
      },
    );
    assert.equal(
      moved.payload.ok,
      true,
    );
    assert.equal(
      await readFile(
        join(
          secondWorkspaceRoot,
          "nested",
          "moved.txt",
        ),
        "utf8",
      ),
      "patched\n",
    );

    const removedCopy =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "delete_file",
        {
          workspace: "second",
          agents_digest:
            agentsDetails
              ?.agentsDigest,
          path:
            "nested/moved.txt",
        },
      );
    assert.equal(
      removedCopy.payload.ok,
      true,
    );

    const transaction =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "workspace_mutate",
        {
          workspace: "second",
          agents_digest:
            agentsDetails
              ?.agentsDigest,
          operations: [
            {
              op: "write",
              path: "tx-a.txt",
              content: "a\n",
            },
            {
              op: "write",
              path: "tx-b.txt",
              content: "b\n",
            },
          ],
          verify: [
            {
              op: "read",
              files: [
                {
                  path: "tx-a.txt",
                },
                {
                  path: "tx-b.txt",
                },
              ],
            },
          ],
        },
      );
    assert.equal(
      transaction.payload.ok,
      true,
    );

    const failedTransaction =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "workspace_mutate",
        {
          workspace: "second",
          agents_digest:
            agentsDetails
              ?.agentsDigest,
          operations: [
            {
              op: "write",
              path:
                "must-rollback.txt",
              content:
                "temporary\n",
            },
            {
              op: "delete",
              path:
                "still-missing.txt",
            },
          ],
        },
        true,
      );
    assert.equal(
      failedTransaction.isError,
      true,
    );
    assert.equal(
      failedTransaction
        .payload.code,
      "path_not_found",
    );
    await assert.rejects(
      readFile(
        join(
          secondWorkspaceRoot,
          "must-rollback.txt",
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

    const laterFailure =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "delete_file",
        {
          workspace: "second",
          agents_digest:
            agentsDetails
              ?.agentsDigest,
          path: "missing.txt",
        },
        true,
      );
    assert.equal(
      laterFailure.isError,
      true,
    );
    assert.equal(
      laterFailure.payload.code,
      "path_not_found",
    );
    assert.equal(
      await readFile(
        join(
          secondWorkspaceRoot,
          "tx-a.txt",
        ),
        "utf8",
      ),
      "a\n",
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

    const endedTurn =
      await callMcpTool(
        mcpOrigin,
        mcpSessionId,
        "junius_turn_end",
        {},
        true,
      );
    assert.equal(
      endedTurn.isError,
      false,
    );

    const sessionObservabilityPath =
      join(
        root,
        "runtime",
        "observability",
        "sessions",
      );
    assert.equal(
      (
        await readdir(
          sessionObservabilityPath,
        )
      ).length,
      1,
    );

    assert.ok(
      mcpSessionId,
    );
    const deletedSession =
      await fetch(
        mcpOrigin + "/mcp",
        {
          method: "DELETE",
          headers: {
            accept:
              "application/json, text/event-stream",
            "mcp-session-id":
              mcpSessionId,
          },
        },
      );
    const deletedSessionBody =
      await deletedSession.text();
    assert.equal(
      deletedSession.ok,
      true,
      deletedSessionBody,
    );
    assert.deepEqual(
      await readdir(
        sessionObservabilityPath,
      ),
      [],
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
