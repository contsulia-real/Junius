import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { WorkspaceFilesService } from "./workspace-files.js";
import {
  fileToolError,
  stableIdSchema,
  workspacePathSchema,
} from "./mcp-tool-shared.js";

function agentInstructionsField(
  value: Awaited<
    ReturnType<
      WorkspaceFilesService["agentInstructionsForPaths"]
    >
  >,
) {
  return value.instructions.length === 0
    ? {}
    : { agentInstructions: value };
}

export function registerWorkspaceFileTools(
  server: McpServer,
  files: WorkspaceFilesService,
): void {
  server.registerTool(
    "ls",
    {
      title: "List Workspace Files",
      description:
        "List files and directories inside one registered Junius Workspace. Paths are Workspace-relative. If AGENTS.md files apply to or are discovered within the scanned scope, Junius returns their contents and scope metadata so the agent must follow them.",
      inputSchema: z.object({
        workspace: stableIdSchema,
        path: workspacePathSchema.default("."),
        depth: z.number().int().min(1).max(4).default(1),
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
    async ({ workspace, path, depth }) => {
      try {
        const [
          entries,
          agentInstructions,
        ] = await Promise.all([
          files.ls(
            workspace,
            path,
            depth,
          ),
          files.agentInstructionsForScan(
            workspace,
            path,
            depth,
          ),
        ]);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                workspace,
                path,
                entries,
                ...agentInstructionsField(
                  agentInstructions,
                ),
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
    "read",
    {
      title: "Read Workspace Files",
      description:
        "Read one or more UTF-8 text files from a registered Junius Workspace. Applicable AGENTS.md instructions are returned with the read result and must govern agent behavior for files in their scope.",
      inputSchema: z.object({
        workspace: stableIdSchema,
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
    async ({ workspace, files: requests }) => {
      try {
        const readRequests =
          requests.map((request) => ({
            path: request.path,
            ...(request.start_line === undefined
              ? {}
              : { startLine: request.start_line }),
            ...(request.end_line === undefined
              ? {}
              : { endLine: request.end_line }),
          }));

        const [
          results,
          agentInstructions,
        ] = await Promise.all([
          files.read(
            workspace,
            readRequests,
          ),
          files.agentInstructionsForPaths(
            workspace,
            readRequests.map(
              (request) =>
                request.path,
            ),
          ),
        ]);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                workspace,
                files: results,
                ...agentInstructionsField(
                  agentInstructions,
                ),
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
    "write",
    {
      title: "Write Workspace Files",
      description:
        "Create, replace, or exact-text edit UTF-8 files inside a registered Junius Workspace. Applicable AGENTS.md instructions are a mandatory preflight: when they exist, a mutation without the current agents_digest is rejected with the full instruction set and digest; follow those instructions and retry with that digest. Exact-text edits fail if old_text is missing or ambiguous unless replace_all is explicitly enabled. All writes are validated before any file is changed.",
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
                if (
                  (file.content === undefined) ===
                  (file.edits === undefined)
                ) {
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
      agents_digest,
    }) => {
      try {
        const writeRequests =
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
          }));

        const results = await files.write(
          workspace,
          writeRequests,
          "write",
          agents_digest,
        );

        const agentInstructions =
          await files.agentInstructionsForPaths(
            workspace,
            writeRequests.map(
              (request) =>
                request.path,
            ),
          );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                workspace,
                files: results,
                ...agentInstructionsField(
                  agentInstructions,
                ),
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
    "rg",
    {
      title: "Search Workspace Text",
      description:
        "Search text inside one registered Junius Workspace using ripgrep. Paths are Workspace-relative and ripgrep configuration files are disabled. AGENTS.md files applicable to or nested inside the recursive search scope are returned so the agent must apply their directory-scoped instructions.",
      inputSchema: z.object({
        workspace: stableIdSchema,
        query: z.string().min(1).max(4_096),
        path: workspacePathSchema.default("."),
        globs: z.array(z.string().min(1).max(1_024)).max(32).default([]),
        case_sensitive: z.boolean().default(true),
        fixed_strings: z.boolean().default(false),
        hidden: z.boolean().default(false),
        max_results: z.number().int().min(1).max(500).default(100),
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
    async ({
      workspace,
      query,
      path,
      globs,
      case_sensitive,
      fixed_strings,
      hidden,
      max_results,
    }) => {
      try {
        const [
          matches,
          agentInstructions,
        ] = await Promise.all([
          files.rg(workspace, {
            query,
            path,
            globs,
            caseSensitive: case_sensitive,
            fixedStrings: fixed_strings,
            hidden,
            maxResults: max_results,
          }),
          files.agentInstructionsForScan(
            workspace,
            path,
          ),
        ]);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                workspace,
                query,
                matches,
                ...agentInstructionsField(
                  agentInstructions,
                ),
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
