import {
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { createMcpServer } from "./mcp-server.js";
import { RunCommandService } from "./run-command.js";
import { WorkspaceFilesService } from "./workspace-files.js";
import { JobManager } from "./job-manager.js";
import { PlaywrightCliService } from "./playwright-cli.js";
import { DesktopComputerUseService } from "./desktop-computer-use.js";

export interface McpRuntime {
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export async function createMcpRuntime(
  commands: RunCommandService,
  files: WorkspaceFilesService,
  jobs: JobManager,
  playwrightCli: PlaywrightCliService,
  desktop: DesktopComputerUseService,
): Promise<McpRuntime> {
  const modernHandler = createMcpHandler(
    () => createMcpServer(commands, files, jobs, playwrightCli, desktop),
    {
    legacy: "reject",
    onerror(error) {
      console.error("[mcp modern]", error);
    },
    },
  );

  const legacyServer = createMcpServer(commands, files, jobs, playwrightCli, desktop);
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
