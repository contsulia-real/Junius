import {
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { createMcpServer } from "./mcp-server.js";
import { RunCommandService } from "./run-command.js";

export interface McpRuntime {
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export async function createMcpRuntime(
  service: RunCommandService,
): Promise<McpRuntime> {
  const modernHandler = createMcpHandler(() => createMcpServer(service), {
    legacy: "reject",
    onerror(error) {
      console.error("[mcp modern]", error);
    },
  });

  const legacyServer = createMcpServer(service);
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
