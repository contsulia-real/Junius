import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { RunCommandService, type RunCommandResult } from "./run-command.js";

const stableIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const runCommandInputSchema = z.object({
  workspace: stableIdSchema.describe(
    "Registered Junius Workspace ID. This is an ID managed by Junius, not a filesystem path.",
  ),
  key: stableIdSchema.describe("Registered Junius capability key."),
  args: z
    .array(z.string().max(4_096))
    .max(128)
    .default([])
    .describe("Argument vector passed to the registered capability adapter."),
});

function resultText(result: RunCommandResult): string {
  if (!result.ok) {
    return `${result.code}: ${result.workspace}:${result.key}`;
  }

  return JSON.stringify({
    workspace: result.workspace,
    key: result.key,
    exitCode: result.execution.exitCode,
    stdout: result.execution.stdout,
    stderr: result.execution.stderr,
    durationMs: result.execution.durationMs,
  });
}

export function createMcpServer(service: RunCommandService): McpServer {
  const server = new McpServer({
    name: "Junius",
    title: "Junius Local Agent",
    version: "0.5.0",
  });

  server.registerTool(
    "list_workspaces",
    {
      title: "List Junius Workspaces",
      description:
        "List registered Junius Workspaces, their roots, and the capability argument grants available in each Workspace. Use this before choosing a Workspace when the user refers to a project by name rather than by Workspace ID.",
      inputSchema: z.object({}),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            workspaces: service.listWorkspaces(),
          }),
        },
      ],
    }),
  );

  server.registerTool(
    "run_command",
    {
      title: "Run Junius Capability",
      description:
        "Run one registered Junius capability in one explicitly selected Junius Workspace. If the user names a project rather than a Workspace ID, use list_workspaces first. The Workspace ID and capability key must already be registered and authorized. Filesystem paths and shell command strings are not accepted as capability selectors.",
      inputSchema: runCommandInputSchema,
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspace, key, args }) => {
      const result = await service.run(workspace, key, args);

      return {
        isError: !result.ok,
        content: [
          {
            type: "text" as const,
            text: resultText(result),
          },
        ],
      };
    },
  );

  return server;
}
