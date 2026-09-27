import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { RunCommandService } from "./run-command.js";
import type { WorkspaceFilesService } from "./workspace-files.js";
import {
  fileToolError,
  stableIdSchema,
  workspacePathSchema,
} from "./mcp-tool-shared.js";

export function registerWorkspaceFileTools(
  server: McpServer,
  commands: RunCommandService,
  files: WorkspaceFilesService,
): void {
  server.registerTool(
    "list_workspaces",
    {
      title: "List Junius Workspaces",
      description:
        "List registered Junius Workspaces, their roots, and the capability argument grants available in each Workspace. Use this before choosing a Workspace when the user refers to a project by name rather than by Workspace ID.",
      inputSchema: z.object({}),
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
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            workspaces: commands.listWorkspaces(),
          }),
        },
      ],
    }),
  );

  server.registerTool(
    "ls",
    {
      title: "List Workspace Files",
      description:
        "List files and directories inside one registered Junius Workspace. Paths are Workspace-relative.",
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
        const entries = await files.ls(workspace, path, depth);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                workspace,
                path,
                entries,
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
        "Read one or more UTF-8 text files from a registered Junius Workspace.",
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
        const results = await files.read(
          workspace,
          requests.map((request) => ({
            path: request.path,
            ...(request.start_line === undefined
              ? {}
              : { startLine: request.start_line }),
            ...(request.end_line === undefined
              ? {}
              : { endLine: request.end_line }),
          })),
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                workspace,
                files: results,
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
        "Create, replace, or exact-text edit UTF-8 files inside a registered Junius Workspace. A prior read is not required. Exact-text edits fail if old_text is missing or ambiguous unless replace_all is explicitly enabled. All writes are validated before any file is changed.",
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
    async ({ workspace, files: requests }) => {
      try {
        const results = await files.write(
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
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                workspace,
                files: results,
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
        "Search text inside one registered Junius Workspace using ripgrep. Paths are Workspace-relative and ripgrep configuration files are disabled.",
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
        const matches = await files.rg(workspace, {
          query,
          path,
          globs,
          caseSensitive: case_sensitive,
          fixedStrings: fixed_strings,
          hidden,
          maxResults: max_results,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                workspace,
                query,
                matches,
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
