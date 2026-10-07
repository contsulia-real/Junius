import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  configureMcpHttpServer,
  MCP_HTTP_KEEP_ALIVE_MS,
} from "./mcp-http-tuning.js";

test("configureMcpHttpServer keeps burst connections alive without timing out long responses", () => {
  const server = createServer();

  try {
    configureMcpHttpServer(server);

    assert.equal(
      server.keepAliveTimeout,
      MCP_HTTP_KEEP_ALIVE_MS,
    );
    assert.ok(
      server.headersTimeout > server.keepAliveTimeout,
    );
    assert.equal(server.timeout, 0);
  } finally {
    server.close();
  }
});
