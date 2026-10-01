import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { WorkspaceFilesService, WorkspaceMutation } from "./workspace-files.js";
import { fileToolError, stableIdSchema, workspacePathSchema } from "./mcp-tool-shared.js";
import { runWorkspacePatch } from "./workspace-patch.js";
import { runWorkspaceMutate } from "./workspace-mutate.js";
import { mapWorkspaceVerifyOperations, workspaceVerifySchema } from "./mcp-workspace-verify.js";

const agentsDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u).optional().describe(
  "Digest returned by an AGENTS.md preflight. Required when applicable AGENTS.md instructions exist.",
);

const mutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

function success(workspace: string, mutations: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ ok: true, workspace, mutations }),
    }],
  };
}

const batchOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("write"),
    path: workspacePathSchema,
    content: z.string().max(2 * 1024 * 1024),
  }),
  z.object({
    op: z.literal("delete"),
    path: workspacePathSchema,
  }),
  z.object({
    op: z.literal("move"),
    source: workspacePathSchema,
    destination: workspacePathSchema,
    overwrite: z.boolean().default(false),
  }),
  z.object({
    op: z.literal("copy"),
    source: workspacePathSchema,
    destination: workspacePathSchema,
    overwrite: z.boolean().default(false),
  }),
  z.object({
    op: z.literal("mkdir"),
    path: workspacePathSchema,
  }),
]);

function mapBatchOperation(operation: z.infer<typeof batchOperationSchema>): WorkspaceMutation {
  switch (operation.op) {
    case "write":
      return { kind: "write", path: operation.path, content: operation.content };
    case "delete":
      return { kind: "delete", path: operation.path };
    case "move":
      return {
        kind: "move",
        source: operation.source,
        destination: operation.destination,
        overwrite: operation.overwrite,
      };
    case "copy":
      return {
        kind: "copy",
        source: operation.source,
        destination: operation.destination,
        overwrite: operation.overwrite,
      };
    case "mkdir":
      return { kind: "mkdir", path: operation.path };
  }
}

export function registerWorkspaceMutationTools(
  server: McpServer,
  files: WorkspaceFilesService,
): void {
  server.registerTool(
    "write_file",
    {
      title: "Write Workspace File",
      description:
        "Create or replace one UTF-8 text file in the current Workspace working tree. The change is committed to the working tree immediately; later Workspace edits are independent. AGENTS.md acknowledgement and Workspace path protections remain mandatory.",
      inputSchema: z.object({
        workspace: stableIdSchema,
        path: workspacePathSchema,
        content: z.string().max(2 * 1024 * 1024),
        agents_digest: agentsDigestSchema,
      }),
      _meta: { securitySchemes: [{ type: "noauth" }] },
      annotations: mutationAnnotations,
    },
    async ({ workspace, path, content, agents_digest }) => {
      try {
        const results = await files.mutate(
          workspace,
          [{ kind: "write", path, content }],
          "write_file",
          agents_digest,
        );
        return success(workspace, results);
      } catch (error) {
        return fileToolError(error);
      }
    },
  );

  server.registerTool(
    "apply_patch",
    {
      title: "Apply Workspace Patch",
      description:
        "Apply a standard unified diff to the Workspace as one explicit atomic patch operation. Supports create, update, delete, rename/move, multiple files, multiple hunks, CRLF preservation, and no-newline markers. Patch size is bounded by payload size rather than a fixed file-count limit.",
      inputSchema: z.object({
        workspace: stableIdSchema,
        patch: z.string().min(1).max(8 * 1024 * 1024),
        agents_digest: agentsDigestSchema,
        verify: workspaceVerifySchema,
      }),
      _meta: { securitySchemes: [{ type: "noauth" }] },
      annotations: mutationAnnotations,
    },
    async ({ workspace, patch, agents_digest, verify }) => {
      try {
        const result = await runWorkspacePatch(
          files,
          workspace,
          patch,
          mapWorkspaceVerifyOperations(verify),
          agents_digest,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ...result }) }],
        };
      } catch (error) {
        return fileToolError(error);
      }
    },
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete Workspace File",
      description:
        "Delete one file from the Workspace working tree immediately. Only the current operation is atomic; earlier successful edits remain in the working tree.",
      inputSchema: z.object({
        workspace: stableIdSchema,
        path: workspacePathSchema,
        agents_digest: agentsDigestSchema,
      }),
      _meta: { securitySchemes: [{ type: "noauth" }] },
      annotations: mutationAnnotations,
    },
    async ({ workspace, path, agents_digest }) => {
      try {
        const results = await files.mutate(
          workspace,
          [{ kind: "delete", path }],
          "delete_file",
          agents_digest,
        );
        return success(workspace, results);
      } catch (error) {
        return fileToolError(error);
      }
    },
  );

  server.registerTool(
    "move_file",
    {
      title: "Move Workspace File",
      description:
        "Move or rename one file inside the Workspace working tree immediately. Destination overwrite is opt-in.",
      inputSchema: z.object({
        workspace: stableIdSchema,
        source: workspacePathSchema,
        destination: workspacePathSchema,
        overwrite: z.boolean().default(false),
        agents_digest: agentsDigestSchema,
      }),
      _meta: { securitySchemes: [{ type: "noauth" }] },
      annotations: mutationAnnotations,
    },
    async ({ workspace, source, destination, overwrite, agents_digest }) => {
      try {
        const results = await files.mutate(
          workspace,
          [{ kind: "move", source, destination, overwrite }],
          "move_file",
          agents_digest,
        );
        return success(workspace, results);
      } catch (error) {
        return fileToolError(error);
      }
    },
  );

  server.registerTool(
    "copy_file",
    {
      title: "Copy Workspace File",
      description:
        "Copy one file inside the Workspace working tree immediately. Copy preserves file bytes and mode; destination overwrite is opt-in.",
      inputSchema: z.object({
        workspace: stableIdSchema,
        source: workspacePathSchema,
        destination: workspacePathSchema,
        overwrite: z.boolean().default(false),
        agents_digest: agentsDigestSchema,
      }),
      _meta: { securitySchemes: [{ type: "noauth" }] },
      annotations: mutationAnnotations,
    },
    async ({ workspace, source, destination, overwrite, agents_digest }) => {
      try {
        const results = await files.mutate(
          workspace,
          [{ kind: "copy", source, destination, overwrite }],
          "copy_file",
          agents_digest,
        );
        return success(workspace, results);
      } catch (error) {
        return fileToolError(error);
      }
    },
  );

  server.registerTool(
    "mkdir",
    {
      title: "Create Workspace Directory",
      description:
        "Create a directory and any missing parent directories inside the Workspace working tree immediately.",
      inputSchema: z.object({
        workspace: stableIdSchema,
        path: workspacePathSchema,
        agents_digest: agentsDigestSchema,
      }),
      _meta: { securitySchemes: [{ type: "noauth" }] },
      annotations: mutationAnnotations,
    },
    async ({ workspace, path, agents_digest }) => {
      try {
        const results = await files.mutate(
          workspace,
          [{ kind: "mkdir", path }],
          "mkdir",
          agents_digest,
        );
        return success(workspace, results);
      } catch (error) {
        return fileToolError(error);
      }
    },
  );

  server.registerTool(
    "workspace_mutate",
    {
      title: "Mutate Workspace Transactionally",
      description:
        "Explicit all-or-nothing batch for cases where several writes, deletes, moves, copies, or directory creations must succeed together. This is optional: ordinary editing should use the individual mutation tools so each successful step remains in the working tree for later inspection, testing, and further edits.",
      inputSchema: z.object({
        workspace: stableIdSchema,
        operations: z.array(batchOperationSchema).min(1).max(256),
        agents_digest: agentsDigestSchema,
        verify: workspaceVerifySchema,
      }),
      _meta: { securitySchemes: [{ type: "noauth" }] },
      annotations: mutationAnnotations,
    },
    async ({ workspace, operations, agents_digest, verify }) => {
      try {
        const result = await runWorkspaceMutate(
          files,
          workspace,
          operations.map(mapBatchOperation),
          mapWorkspaceVerifyOperations(verify),
          agents_digest,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ...result }) }],
        };
      } catch (error) {
        return fileToolError(error);
      }
    },
  );
}
