import type { McpServer } from "@modelcontextprotocol/server";
import {
  FOREGROUND_COMMAND_TIMEOUT_MS,
  type RunCommandService,
} from "./run-command.js";
import {
  formatRunCommandResult,
  runCommandInputSchema,
} from "./mcp-tool-shared.js";

export function registerRunCommandTool(
  server: McpServer,
  commands:
    RunCommandService,
): void {
  server.registerTool(
    "run_command",
    {
      title:
        "Run Local Command",
      description:
        `Run one short foreground command in a registered Workspace. It is capped at ${FOREGROUND_COMMAND_TIMEOUT_MS / 1_000} seconds so one Secure MCP Tunnel request cannot be held by long work. Use run_commands for multiple short commands and start_job for anything that may take longer. Junius does not restrict executable names or argument vectors.`,
      inputSchema:
        runCommandInputSchema,
      _meta: {
        securitySchemes: [
          { type: "noauth" },
        ],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      workspace,
      executable,
      args,
    }) => {
      const result =
        await commands.run(
          workspace,
          executable,
          args,
        );

      return {
        isError: !result.ok,
        content: [
          {
            type:
              "text" as const,
            text:
              formatRunCommandResult(
                result,
              ),
          },
        ],
      };
    },
  );
}
