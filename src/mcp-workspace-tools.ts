import type { McpServer } from "@modelcontextprotocol/server";
import type { WorkspaceFilesService } from "./workspace-files.js";
import type { WorkspaceRegistryService } from "./workspace-registry.js";
import { registerWorkspaceFileTools } from "./mcp-workspace-file-tools.js";
import { registerWorkspaceBatchTools } from "./mcp-workspace-batch-tools.js";
import { registerWorkspaceRegistryTools } from "./mcp-workspace-registry-tools.js";
import { registerWorkspaceMutationTools } from "./mcp-workspace-mutation-tools.js";

export function registerWorkspaceTools(
  server: McpServer,
  workspaces:
    WorkspaceRegistryService,
  files:
    WorkspaceFilesService,
): void {
  registerWorkspaceRegistryTools(
    server,
    workspaces,
  );
  registerWorkspaceFileTools(
    server,
    files,
  );
  registerWorkspaceBatchTools(
    server,
    files,
  );
  registerWorkspaceMutationTools(
    server,
    files,
  );
}
