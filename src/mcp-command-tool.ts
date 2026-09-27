import type { McpServer } from "@modelcontextprotocol/server";
import type { RunCommandService } from "./run-command.js";
import {
  formatRunCommandResult,
  runCommandInputSchema,
} from "./mcp-tool-shared.js";

export function registerRunCommandTool(
  server: McpServer,
  commands: RunCommandService,
): void {
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
      const result = await commands.run(workspace, key, args);

      return {
        isError: !result.ok,
        content: [
          {
            type: "text" as const,
            text: formatRunCommandResult(result),
          },
        ],
      };
    },
  );
}
