import type { McpServer } from "@modelcontextprotocol/server";
import type { WorkspaceFilesService } from "./workspace-files.js";
import { registerWorkspaceApplyTool } from "./mcp-workspace-apply-tool.js";
import { registerWorkspaceReadBatchTool } from "./mcp-workspace-read-batch-tool.js";

export function registerWorkspaceBatchTools(
  server: McpServer,
  files: WorkspaceFilesService,
): void {
  registerWorkspaceApplyTool(server, files);
  registerWorkspaceReadBatchTool(server, files);
}
