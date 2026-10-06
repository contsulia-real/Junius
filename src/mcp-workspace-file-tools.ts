import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { WorkspaceFilesService } from "./workspace-files.js";
import { fileToolError, stableIdSchema, workspacePathSchema } from "./mcp-tool-shared.js";

function agentInstructionsField(
  value: Awaited<ReturnType<WorkspaceFilesService["agentInstructionsForPaths"]>>,
) {
  return value.instructions.length === 0 ? {} : { agentInstructions: value };
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
      _meta: { securitySchemes: [{ type: "noauth" }] },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace, path, depth }) => {
      try {
        const [entries, agentInstructions] = await Promise.all([
          files.ls(workspace, path, depth),
          files.agentInstructionsForScan(workspace, path, depth),
        ]);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              workspace,
              path,
              entries,
              ...agentInstructionsField(agentInstructions),
            }),
          }],
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
        files: z.array(z.object({
          path: workspacePathSchema,
          start_line: z.number().int().min(1).optional(),
          end_line: z.number().int().min(1).optional(),
        })).min(1).max(16),
      }),
      _meta: { securitySchemes: [{ type: "noauth" }] },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace, files: requests }) => {
      try {
        const readRequests = requests.map((request) => ({
          path: request.path,
          ...(request.start_line === undefined ? {} : { startLine: request.start_line }),
          ...(request.end_line === undefined ? {} : { endLine: request.end_line }),
        }));
        const [results, agentInstructions] = await Promise.all([
          files.read(workspace, readRequests),
          files.agentInstructionsForPaths(workspace, readRequests.map((request) => request.path)),
        ]);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              workspace,
              files: results,
              ...agentInstructionsField(agentInstructions),
            }),
          }],
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
        "Search text inside one registered Junius Workspace. Junius prefers ripgrep and falls back to `pwsh`, then `cmd` on Windows when earlier backends are unavailable. Paths are Workspace-relative, ripgrep configuration files are disabled, and protected Workspace paths remain excluded. AGENTS.md files applicable to or nested inside the recursive search scope are returned so the agent must apply their directory-scoped instructions.",
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
      _meta: { securitySchemes: [{ type: "noauth" }] },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace, query, path, globs, case_sensitive, fixed_strings, hidden, max_results }) => {
      try {
        const [matches, agentInstructions] = await Promise.all([
          files.rg(workspace, {
            query,
            path,
            globs,
            caseSensitive: case_sensitive,
            fixedStrings: fixed_strings,
            hidden,
            maxResults: max_results,
          }),
          files.agentInstructionsForScan(workspace, path),
        ]);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              workspace,
              query,
              matches,
              ...agentInstructionsField(agentInstructions),
            }),
          }],
        };
      } catch (error) {
        return fileToolError(error);
      }
    },
  );
}
