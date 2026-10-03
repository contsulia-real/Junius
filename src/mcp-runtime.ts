import {
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { createMcpServer } from "./mcp-server.js";
import { RunCommandService } from "./run-command.js";
import { WorkspaceFilesService } from "./workspace-files.js";
import type { WorkspaceRegistryService } from "./workspace-registry.js";
import { JobManager } from "./job-manager.js";
import { PlaywrightCliService } from "./playwright-cli.js";
import { DesktopComputerUseService } from "./desktop-computer-use.js";
import type { AuditStore } from "./audit-store.js";
import type { McpObservabilityStore } from "./mcp-observability.js";

export interface McpRuntime {
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export async function createMcpRuntime(
  commands: RunCommandService,
  workspaces: WorkspaceRegistryService,
  files: WorkspaceFilesService,
  jobs: JobManager,
  playwrightCli: PlaywrightCliService,
  desktop: DesktopComputerUseService,
  audit?: AuditStore,
  observability?: McpObservabilityStore,
): Promise<McpRuntime> {
  const modernHandler = createMcpHandler(
    () => createMcpServer(
      commands,
      workspaces,
      files,
      jobs,
      playwrightCli,
      desktop,
      audit,
      observability,
    ),
    {
    legacy: "reject",
    onerror(error) {
      console.error("[mcp modern]", error);
    },
    },
  );

  const legacyServer =
    createMcpServer(
      commands,
      workspaces,
      files,
      jobs,
      playwrightCli,
      desktop,
      audit,
      observability,
    );
  const legacyTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
  });

  await legacyServer.connect(legacyTransport);

  return {
    async handle(request) {
      return (await isLegacyRequest(request))
        ? legacyTransport.handleRequest(request)
        : modernHandler.fetch(request);
    },

    async close() {
      await Promise.allSettled([
        modernHandler.close(),
        legacyServer.close(),
      ]);
    },
  };
}
