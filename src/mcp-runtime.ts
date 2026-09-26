import {
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { createMcpServer } from "./mcp-server.js";
import { RunCommandService } from "./run-command.js";
import { WorkspaceFilesService } from "./workspace-files.js";

export interface McpRuntime {
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export async function createMcpRuntime(
  commands: RunCommandService,
  files: WorkspaceFilesService,
): Promise<McpRuntime> {
  const modernHandler = createMcpHandler(
    () => createMcpServer(commands, files),
    {
    legacy: "reject",
    onerror(error) {
      console.error("[mcp modern]", error);
    },
    },
  );

  const legacyServer = createMcpServer(commands, files);
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
