import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { RunCommandService, type RunCommandResult } from "./run-command.js";

const capabilityKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const runCommandInputSchema = z.object({
  key: capabilityKeySchema.describe("Registered Junius capability key."),
  args: z
    .array(z.string().max(4_096))
    .max(128)
    .default([])
    .describe("Argument vector passed to the registered capability adapter."),
});

function resultText(result: RunCommandResult): string {
  if (!result.ok) {
    return `${result.code}: ${result.key}`;
  }

  return JSON.stringify({
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
    version: "0.3.0",
  });

  server.registerTool(
    "run_command",
    {
      title: "Run Junius Capability",
      description:
        "Run one Junius capability by key. The key must be registered on this machine and allowed by the current Workspace Profile. Executable paths and shell command strings are not accepted.",
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
    async ({ key, args }) => {
      const result = await service.run(key, args);

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
