import type {
  McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type {
  WorkspaceFilesService,
} from "./workspace-files.js";
import {
  runWorkspacePatch,
} from "./workspace-patch.js";
import {
  fileToolError,
  stableIdSchema,
} from "./mcp-tool-shared.js";
import {
  mapWorkspaceVerifyOperations,
  workspaceVerifySchema,
} from "./mcp-workspace-verify.js";

export function registerWorkspacePatchTool(
  server: McpServer,
  files:
    WorkspaceFilesService,
): void {
  server.registerTool(
    "workspace_patch",
    {
      title:
        "Patch Workspace Files",
      description:
        "Apply one standard unified diff to up to 16 UTF-8 text files in a registered Workspace, transactionally, then optionally run read-only verification operations in the same MCP round trip. Patch hunks use their line positions and context, so callers do not need to repeat large exact old_text blocks. Existing Workspace path protections, AGENTS.md digest acknowledgement, pre-commit validation, rollback, file-size limits, and concurrent-change checks remain in force. File creation is supported; rename and deletion are intentionally not handled by this edit tool.",
      inputSchema:
        z.object({
          workspace:
            stableIdSchema,
          patch:
            z.string()
              .min(1)
              .max(
                2 * 1024 * 1024,
              ),
          agents_digest:
            z.string()
              .regex(
                /^[a-f0-9]{64}$/u,
              )
              .optional()
              .describe(
                "Digest returned by an AGENTS.md preflight. Required when applicable AGENTS.md instructions exist.",
              ),
          verify:
            workspaceVerifySchema,
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
        openWorldHint: false,
      },
    },
    async ({
      workspace,
      patch,
      agents_digest,
      verify,
    }) => {
      try {
        const result =
          await runWorkspacePatch(
            files,
            workspace,
            patch,
            mapWorkspaceVerifyOperations(
              verify,
            ),
            agents_digest,
          );

        return {
          content: [
            {
              type:
                "text" as const,
              text:
                JSON.stringify({
                  ok: true,
                  ...result,
                }),
            },
          ],
        };
      } catch (error) {
        return fileToolError(
          error,
        );
      }
    },
  );
}
