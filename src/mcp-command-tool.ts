import type { McpServer } from "@modelcontextprotocol/server";
import type { RunCommandService } from "./run-command.js";
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
        "Launch any executable with any argument vector in one registered Junius Workspace. The Workspace selects cwd only; Junius does not pre-register executables or restrict argument vectors. For software engineering work, load the engineering contract with load_junius_contracts before substantive engineering execution unless it is already loaded.",
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
