import type { Server } from "node:http";

export const MCP_HTTP_KEEP_ALIVE_MS = 60_000;
export const MCP_HTTP_HEADERS_TIMEOUT_MS =
  MCP_HTTP_KEEP_ALIVE_MS + 5_000;

export function configureMcpHttpServer(
  server: Server,
): void {
  server.keepAliveTimeout =
    MCP_HTTP_KEEP_ALIVE_MS;
  server.headersTimeout =
    MCP_HTTP_HEADERS_TIMEOUT_MS;
  server.setTimeout(0);
  server.maxRequestsPerSocket = 0;
}
