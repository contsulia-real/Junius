import type { McpServer } from "@modelcontextprotocol/server";
import type { WorkspaceFilesService } from "./workspace-files.js";
import { registerWorkspaceReadBatchTool } from "./mcp-workspace-read-batch-tool.js";

export function registerWorkspaceBatchTools(
  server: McpServer,
  files: WorkspaceFilesService,
): void {
  registerWorkspaceReadBatchTool(server, files);
}
