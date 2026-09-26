import { once } from "node:events";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import { z } from "zod";

type SpikeToolName = "tool_a" | "tool_b";

const MCP_HOST = "127.0.0.1";
const MCP_PORT = parsePort(process.env.JUNIUS_MCP_PORT, 8787);
const ADMIN_HOST = "127.0.0.1";
const ADMIN_PORT = parsePort(process.env.JUNIUS_ADMIN_PORT, 8788);

let activeTool: SpikeToolName = "tool_a";

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return port;
}

function toolTitle(name: SpikeToolName): string {
  return name === "tool_a" ? "Junius Spike Tool A" : "Junius Spike Tool B";
}

function toolDescription(name: SpikeToolName): string {
  return `Dynamic MCP tool-list spike. The currently active tool is ${name}.`;
}

function toolResult(name: SpikeToolName) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${name} is active.`,
      },
    ],
  };
}

function registerCurrentTool(server: McpServer) {
  const name = activeTool;

  return server.registerTool(
    name,
    {
      title: toolTitle(name),
      description: toolDescription(name),
      inputSchema: z.object({}),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => toolResult(activeTool),
  );
}

function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "Junius",
      title: "Junius Dynamic Tools Spike",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {
          listChanged: true,
        },
      },
    },
  );

  registerCurrentTool(server);
  return server;
}

/**
 * Modern MCP (2026-07-28): each request gets a fresh server surface generated
 * from the current spike state. tools/list_changed is delivered through the
 * subscriptions/listen stream managed by createMcpHandler.
 */
const modernHandler = createMcpHandler(() => createMcpServer(), {
  legacy: "reject",
  onerror(error) {
    console.error("[mcp modern]", error);
  },
});

/**
 * Legacy MCP (2025 era): keep one stateful server/transport alive so the server
 * can push the unsolicited notifications/tools/list_changed notification.
 *
 * One legacy session is sufficient for this spike. Restart Junius before a
 * completely new legacy client session.
 */
const legacyServer = new McpServer(
  {
    name: "Junius",
    title: "Junius Dynamic Tools Spike",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {
        listChanged: true,
      },
    },
  },
);

const legacyTool = registerCurrentTool(legacyServer);
const legacyTransport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: randomUUID,
});

await legacyServer.connect(legacyTransport);

function setActiveTool(next: SpikeToolName): boolean {
  if (next === activeTool) {
    return false;
  }

  activeTool = next;

  // A single update produces one legacy tool-list change notification.
  legacyTool.update({
    name: next,
    title: toolTitle(next),
    description: toolDescription(next),
  });

  // Modern clients receive the corresponding event on subscriptions/listen.
  modernHandler.notify.toolsChanged();
  return true;
}

function isSpikeToolName(value: string): value is SpikeToolName {
  return value === "tool_a" || value === "tool_b";
}

function nodeHeadersToWeb(req: IncomingMessage): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
      continue;
    }

    headers.set(name, value);
  }

  return headers;
}

function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? `${MCP_HOST}:${MCP_PORT}`;
  const url = new URL(req.url ?? "/", `http://${host}`);
  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: nodeHeadersToWeb(req),
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }

  return new Request(url, init);
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;

  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });

  if (response.body === null) {
    res.end();
    return;
  }

  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!res.write(Buffer.from(value))) {
        await once(res, "drain");
      }
    }

    res.end();
  } finally {
    reader.releaseLock();
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const request = toWebRequest(req);
  const url = new URL(request.url);

  if (url.pathname !== "/mcp") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  const response = (await isLegacyRequest(request))
    ? await legacyTransport.handleRequest(request)
    : await modernHandler.fetch(request);

  await writeWebResponse(res, response);
}

function handleAdminRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${ADMIN_HOST}:${ADMIN_PORT}`);

  if (req.method === "GET" && url.pathname === "/state") {
    sendJson(res, 200, { activeTool });
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/switch/")) {
    const requested = url.pathname.slice("/switch/".length);

    if (!isSpikeToolName(requested)) {
      sendJson(res, 400, {
        error: "invalid_tool",
        allowed: ["tool_a", "tool_b"],
      });
      return;
    }

    const changed = setActiveTool(requested);
    sendJson(res, 200, {
      activeTool,
      changed,
    });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

const mcpHttpServer = createHttpServer((req, res) => {
  void handleMcpRequest(req, res).catch((error: unknown) => {
    console.error("[mcp http]", error);

    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal_error" });
      return;
    }

    res.destroy(error instanceof Error ? error : new Error(String(error)));
  });
});

const adminHttpServer = createHttpServer((req, res) => {
  try {
    handleAdminRequest(req, res);
  } catch (error) {
    console.error("[admin http]", error);

    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal_error" });
      return;
    }

    res.destroy(error instanceof Error ? error : new Error(String(error)));
  }
});

mcpHttpServer.listen(MCP_PORT, MCP_HOST, () => {
  console.error(`Junius MCP spike: http://${MCP_HOST}:${MCP_PORT}/mcp`);
});

adminHttpServer.listen(ADMIN_PORT, ADMIN_HOST, () => {
  console.error(`Junius local spike control: http://${ADMIN_HOST}:${ADMIN_PORT}/state`);
});

async function shutdown(signal: string): Promise<void> {
  console.error(`Received ${signal}; shutting down Junius spike.`);

  mcpHttpServer.close();
  adminHttpServer.close();

  await Promise.allSettled([
    modernHandler.close(),
    legacyServer.close(),
  ]);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => {
      process.exit(0);
    });
  });
}
