import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { WorkspaceFilesService } from "./workspace-files.js";
import {
  MAX_WORKSPACE_BATCH_OPERATIONS,
  runWorkspaceReadBatch,
} from "./workspace-batch.js";
import {
  fileToolError,
  stableIdSchema,
  workspacePathSchema,
} from "./mcp-tool-shared.js";

export function registerWorkspaceReadBatchTool(
  server: McpServer,
  files: WorkspaceFilesService,
): void {
  server.registerTool(
    "workspace_batch",
    {
      title: "Batch Workspace Reads",
      description:
        "Execute up to 32 independent read-only Workspace operations in one MCP round trip. Prefer this over repeated ls/read/rg calls when exploring several files or searches. Junius bounds local concurrency and total response size so short bursts do not fan out into many Secure MCP Tunnel requests. Each operation still returns applicable AGENTS.md instructions and isolates expected file errors.",
      inputSchema: z.object({
        workspace: stableIdSchema,
        operations: z
          .array(
            z.discriminatedUnion("op", [
              z.object({
                id: stableIdSchema.optional(),
                op: z.literal("ls"),
                path: workspacePathSchema.default("."),
                depth: z.number().int().min(1).max(4).default(1),
              }),
              z.object({
                id: stableIdSchema.optional(),
                op: z.literal("read"),
                files: z
                  .array(
                    z.object({
                      path: workspacePathSchema,
                      start_line: z.number().int().min(1).optional(),
                      end_line: z.number().int().min(1).optional(),
                    }),
                  )
                  .min(1)
                  .max(16),
              }),
              z.object({
                id: stableIdSchema.optional(),
                op: z.literal("rg"),
                query: z.string().min(1).max(4_096),
                path: workspacePathSchema.default("."),
                globs: z
                  .array(z.string().min(1).max(1_024))
                  .max(32)
                  .default([]),
                case_sensitive: z.boolean().default(true),
                fixed_strings: z.boolean().default(false),
                hidden: z.boolean().default(false),
                max_results: z
                  .number()
                  .int()
                  .min(1)
                  .max(500)
                  .default(100),
              }),
            ]),
          )
          .min(1)
          .max(MAX_WORKSPACE_BATCH_OPERATIONS),
      }),
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
    async ({ workspace, operations }) => {
      try {
        const result = await runWorkspaceReadBatch(
          files,
          workspace,
          operations.map((operation) => {
            switch (operation.op) {
              case "ls":
                return {
                  ...(operation.id === undefined
                    ? {}
                    : { id: operation.id }),
                  op: "ls" as const,
                  path: operation.path,
                  depth: operation.depth,
                };

              case "read":
                return {
                  ...(operation.id === undefined
                    ? {}
                    : { id: operation.id }),
                  op: "read" as const,
                  files: operation.files.map((file) => ({
                    path: file.path,
                    ...(file.start_line === undefined
                      ? {}
                      : { startLine: file.start_line }),
                    ...(file.end_line === undefined
                      ? {}
                      : { endLine: file.end_line }),
                  })),
                };

              case "rg":
                return {
                  ...(operation.id === undefined
                    ? {}
                    : { id: operation.id }),
                  op: "rg" as const,
                  query: operation.query,
                  path: operation.path,
                  globs: operation.globs,
                  caseSensitive: operation.case_sensitive,
                  fixedStrings: operation.fixed_strings,
                  hidden: operation.hidden,
                  maxResults: operation.max_results,
                };
            }
          }),
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                ...result,
              }),
            },
          ],
        };
      } catch (error) {
        return fileToolError(error);
      }
    },
  );
}
