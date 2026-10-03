import { McpServer } from "@modelcontextprotocol/server";
import type { RunCommandService } from "./run-command.js";
import type { WorkspaceFilesService } from "./workspace-files.js";
import type { WorkspaceRegistryService } from "./workspace-registry.js";
import type { JobManager } from "./job-manager.js";
import type { PlaywrightCliService } from "./playwright-cli.js";
import type { DesktopComputerUseService } from "./desktop-computer-use.js";
import type { AuditStore } from "./audit-store.js";
import { McpObservabilityStore } from "./mcp-observability.js";
import { attachMcpObservability } from "./mcp-observability-server.js";
import { registerMcpObservabilityPanel } from "./mcp-observability-panel.js";
import { registerMcpTurnTools } from "./mcp-turn-tools.js";
import { registerWorkspaceTools } from "./mcp-workspace-tools.js";
import { registerBrowserTool } from "./mcp-browser-tool.js";
import { registerDesktopTool } from "./mcp-desktop-tool.js";
import { registerJobTools } from "./mcp-job-tools.js";
import { registerRunCommandTool } from "./mcp-command-tool.js";
import { registerRunCommandsTool } from "./mcp-command-batch-tool.js";
import { registerGitTools } from "./mcp-git-tools.js";
import { registerUpdateTools } from "./mcp-update-tools.js";
import { registerContractTool } from "./mcp-contract-tool.js";
import { registerPromptTools } from "./mcp-prompt-tools.js";
import { registerSkillTools } from "./mcp-skill-tools.js";
import { SkillService } from "./skill-service.js";
import {
  isJuniusDevelopmentInstance,
  resolveJuniusCoreContract,
} from "./junius-contracts.js";
import { JUNIUS_VERSION } from "./project-version.js";

export { formatRunCommandResult } from "./mcp-tool-shared.js";

export function createMcpServer(
  commands: RunCommandService,
  workspaces: WorkspaceRegistryService,
  files: WorkspaceFilesService,
  jobs: JobManager,
  playwrightCli: PlaywrightCliService,
  desktop: DesktopComputerUseService,
  audit?: AuditStore,
  observability: McpObservabilityStore =
    new McpObservabilityStore(),
): McpServer {
  const developmentInstance =
    isJuniusDevelopmentInstance();

  const server = new McpServer(
    {
      name: "Junius",
      title:
        developmentInstance
          ? "Junius (Source Test)"
          : "Junius",
      version: JUNIUS_VERSION,
    },
    {
      instructions:
        resolveJuniusCoreContract(),
    },
  );

  registerContractTool(server);
  registerPromptTools(server);
  registerSkillTools(
    server,
    new SkillService(
      workspaces,
      files,
      {},
      audit,
    ),
  );
  registerWorkspaceTools(server, workspaces, files);
  registerBrowserTool(
    server,
    playwrightCli,
    audit,
  );
  registerDesktopTool(
    server,
    desktop,
    audit,
  );
  registerJobTools(server, jobs);
  registerRunCommandTool(server, commands);
  registerRunCommandsTool(
    server,
    commands,
  );
  registerGitTools(
    server,
    commands,
  );
  if (!developmentInstance) {
    registerUpdateTools(
      server,
    );
  }

  registerMcpTurnTools(
    server,
    observability,
  );
  registerMcpObservabilityPanel(
    server,
    observability,
  );
  attachMcpObservability(
    server,
    observability,
  );

  return server;
}
