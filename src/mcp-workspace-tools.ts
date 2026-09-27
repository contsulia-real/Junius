import type { McpServer } from "@modelcontextprotocol/server";
import type { RunCommandService } from "./run-command.js";
import type { WorkspaceFilesService } from "./workspace-files.js";
import { registerWorkspaceFileTools } from "./mcp-workspace-file-tools.js";
import { registerWorkspaceBatchTools } from "./mcp-workspace-batch-tools.js";

export function registerWorkspaceTools(
  server: McpServer,
  commands: RunCommandService,
  files: WorkspaceFilesService,
): void {
  registerWorkspaceFileTools(server, commands, files);
  registerWorkspaceBatchTools(server, files);
}
