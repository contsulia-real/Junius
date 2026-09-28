import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  stableIdSchema,
} from "./mcp-tool-shared.js";
import {
  WorkspaceRegistryError,
  type WorkspaceRegistryService,
} from "./workspace-registry.js";

function registryError(
  error: unknown,
) {
  if (
    error instanceof
    WorkspaceRegistryError
  ) {
    return {
      isError: true,
      content: [
        {
          type:
            "text" as const,
          text:
            JSON.stringify({
              ok: false,
              code: error.code,
              message:
                error.message,
            }),
        },
      ],
    };
  }

  throw error;
}

export function registerWorkspaceRegistryTools(
  server: McpServer,
  workspaces:
    WorkspaceRegistryService,
): void {
  server.registerTool(
    "list_workspaces",
    {
      title:
        "List Junius Workspaces",
      description:
        "List all registered Junius Workspaces and their canonical root paths.",
      inputSchema:
        z.object({}),
      _meta: {
        securitySchemes: [
          { type: "noauth" },
        ],
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
          type:
            "text" as const,
          text:
            JSON.stringify({
              workspaces:
                workspaces.list(),
            }),
        },
      ],
    }),
  );

  server.registerTool(
    "create_workspace",
    {
      title:
        "Create Junius Workspace",
      description:
        "Register an existing local directory as a Junius Workspace. The directory becomes the cwd for command/job execution and the root for Workspace file tools.",
      inputSchema:
        z.object({
          id:
            stableIdSchema,
          root_path:
            z.string()
              .min(1)
              .max(32_768),
        }),
      _meta: {
        securitySchemes: [
          { type: "noauth" },
        ],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      id,
      root_path,
    }) => {
      try {
        return {
          content: [
            {
              type:
                "text" as const,
              text:
                JSON.stringify({
                  ok: true,
                  workspace:
                    await workspaces
                      .create(
                        id,
                        root_path,
                      ),
                }),
            },
          ],
        };
      } catch (error) {
        return registryError(
          error,
        );
      }
    },
  );

  server.registerTool(
    "delete_workspace",
    {
      title:
        "Delete Junius Workspace",
      description:
        "Unregister a Junius Workspace. This removes only the Junius registration; it does not delete the directory or any files on disk.",
      inputSchema:
        z.object({
          id:
            stableIdSchema,
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
    async ({ id }) => {
      try {
        return {
          content: [
            {
              type:
                "text" as const,
              text:
                JSON.stringify({
                  ok: true,
                  workspace:
                    await workspaces
                      .delete(id),
                }),
            },
          ],
        };
      } catch (error) {
        return registryError(
          error,
        );
      }
    },
  );
}
