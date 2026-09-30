import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { WorkspaceFilesService } from "./workspace-files.js";
import { runWorkspaceApply } from "./workspace-apply.js";
import {
  fileToolError,
  stableIdSchema,
  workspacePathSchema,
} from "./mcp-tool-shared.js";
import {
  mapWorkspaceVerifyOperations,
  workspaceVerifySchema,
} from "./mcp-workspace-verify.js";

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
        verify:
          workspaceVerifySchema,
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
          mapWorkspaceVerifyOperations(
            verify,
          ),
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
