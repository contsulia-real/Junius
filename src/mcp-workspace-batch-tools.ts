import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { WorkspaceFilesService } from "./workspace-files.js";
import { runWorkspaceReadBatch } from "./workspace-batch.js";
import { runWorkspaceApply } from "./workspace-apply.js";
import {
  fileToolError,
  stableIdSchema,
  workspacePathSchema,
} from "./mcp-tool-shared.js";

export function registerWorkspaceBatchTools(
  server: McpServer,
  files: WorkspaceFilesService,
): void {
  server.registerTool(
    "workspace_apply",
    {
      title: "Apply Workspace Writes",
      description:
        "Apply up to 16 Workspace file writes in one transactional batch, then optionally run up to 16 read-only ls/read/rg verification operations in the same MCP round trip. All write targets are prepared before commit; if commit fails, Junius attempts reverse rollback. Verification observes the committed result and does not make autonomous rollback decisions.",
      inputSchema: z.object({
        workspace: stableIdSchema,
        files: z
          .array(
            z
              .object({
                path: workspacePathSchema,
                content: z.string().max(2 * 1024 * 1024).optional(),
                edits: z
                  .array(
                    z.object({
                      old_text: z.string().min(1),
                      new_text: z.string(),
                      replace_all: z.boolean().default(false),
                    }),
                  )
                  .min(1)
                  .max(128)
                  .optional(),
              })
              .superRefine((file, context) => {
                if ((file.content === undefined) === (file.edits === undefined)) {
                  context.addIssue({
                    code: "custom",
                    message:
                      "Exactly one of content or edits must be supplied.",
                  });
                }
              }),
          )
          .min(1)
          .max(16),
        verify: z
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
          .max(16)
          .default([]),
      }),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspace, files: requests, verify }) => {
      try {
        const result = await runWorkspaceApply(
          files,
          workspace,
          requests.map((request) => ({
            path: request.path,
            ...(request.content === undefined
              ? {}
              : { content: request.content }),
            ...(request.edits === undefined
              ? {}
              : {
                  edits: request.edits.map((edit) => ({
                    oldText: edit.old_text,
                    newText: edit.new_text,
                    replaceAll: edit.replace_all,
                  })),
                }),
          })),
          verify.map((operation) => {
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


  server.registerTool(
    "workspace_batch",
    {
      title: "Batch Workspace Reads",
      description:
        "Execute up to 16 independent read-only Workspace operations in one MCP round trip. Supports ls, read, and rg. Operations run concurrently, expected file errors are isolated per operation, and response sizes are bounded. Use this when multiple known inspections can be issued together instead of making separate ls/read/rg calls.",
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
          .max(16),
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
