import type {
  McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  runCommandBatch,
} from "./command-batch.js";
import type {
  RunCommandService,
} from "./run-command.js";
import {
  runCommandResultPayload,
  stableIdSchema,
} from "./mcp-tool-shared.js";

const commandSpecSchema =
  z.object({
    executable:
      z.string()
        .min(1)
        .max(4_096),
    args:
      z.array(
        z.string().max(
          65_536,
        ),
      )
        .max(256)
        .default([]),
  });

export function registerRunCommandsTool(
  server: McpServer,
  commands:
    RunCommandService,
): void {
  server.registerTool(
    "run_commands",
    {
      title:
        "Run Local Commands",
      description:
        "Run up to 16 executable/argument-vector commands in one registered Workspace, either in parallel or serially. This is the high-level batching form of run_command and uses the same unrestricted execution path. Use parallel mode for independent short commands and serial mode for ordered steps. Long-running work should still use Jobs.",
      inputSchema:
        z.object({
          workspace:
            stableIdSchema,
          commands:
            z.array(
              commandSpecSchema,
            )
              .min(1)
              .max(16),
          mode:
            z.enum([
              "parallel",
              "serial",
            ])
              .default(
                "parallel",
              ),
          stop_on_failure:
            z.boolean()
              .default(true),
        }),
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
      commands:
        commandSpecs,
      mode,
      stop_on_failure,
    }) => {
      const batch =
        await runCommandBatch(
          commands,
          workspace,
          commandSpecs,
          mode,
          stop_on_failure,
        );

      return {
        isError:
          !batch.ok,
        content: [
          {
            type:
              "text" as const,
            text:
              JSON.stringify({
                ok:
                  batch.ok,
                mode:
                  batch.mode,
                stoppedEarly:
                  batch
                    .stoppedEarly,
                items:
                  batch.items
                    .map(
                      (item) =>
                        item.skipped
                          ? item
                          : {
                              index:
                                item.index,
                              skipped:
                                false,
                              result:
                                runCommandResultPayload(
                                  item.result,
                                ),
                            },
                    ),
              }),
          },
        ],
      };
    },
  );
}
