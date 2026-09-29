import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { WorkspaceFilesService } from "./workspace-files.js";
import { runWorkspaceApply } from "./workspace-apply.js";
import {
  fileToolError,
  stableIdSchema,
  workspacePathSchema,
} from "./mcp-tool-shared.js";

export function registerWorkspaceApplyTool(
  server: McpServer,
  files: WorkspaceFilesService,
): void {
  server.registerTool(
    "workspace_apply",
    {
      title: "Apply Workspace Writes",
      description:
        "Apply up to 16 Workspace file writes in one transactional batch, then optionally run up to 16 read-only ls/read/rg verification operations in the same MCP round trip. For software engineering work, load the engineering contract with load_junius_contracts before implementation unless it is already loaded. Applicable AGENTS.md instructions are a mandatory preflight: if they exist, a mutation without the current agents_digest is rejected with the full instruction set and digest; follow those instructions and retry with that digest. All write targets are prepared before commit; if commit fails, Junius attempts reverse rollback.",
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
        agents_digest: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional()
          .describe(
            "Digest returned by an AGENTS.md preflight. Required when applicable AGENTS.md instructions exist.",
          ),
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
    async ({
      workspace,
      files: requests,
      verify,
      agents_digest,
    }) => {
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
          agents_digest,
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
