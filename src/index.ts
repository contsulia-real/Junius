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

const MCP_HOST = "127.0.0.1";
const MCP_PORT = parsePort(process.env.JUNIUS_MCP_PORT, 8787);
const ADMIN_HOST = "127.0.0.1";
const ADMIN_PORT = parsePort(process.env.JUNIUS_ADMIN_PORT, 8788);

interface Capability {
  readonly key: string;
  execute(args: readonly string[]): Promise<string>;
}

function createTestCapability(key: string): Capability {
  return {
    key,
    async execute(args) {
      return `${key} executed; args=${JSON.stringify(args)}`;
    },
  };
}

/**
 * Machine-level Capability Registry for this spike.
 *
 * These are deliberately synthetic adapters: this test is about the fixed
 * run_command MCP surface plus dynamic Workspace Profile authorization. Real
 * executable spawning belongs to the later Capability Adapter implementation.
 */
const capabilityRegistry = new Map<string, Capability>([
  ["tool_a", createTestCapability("tool_a")],
  ["tool_b", createTestCapability("tool_b")],
]);

/**
 * Minimal in-memory Workspace Profile standing in for the future Dashboard
 * persistence layer. The Dashboard/admin side may mutate this set at runtime;
 * the MCP tool schema never changes.
 */
const workspaceAllowedKeys = new Set<string>(["tool_a"]);

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

function registeredKeys(): string[] {
  return [...capabilityRegistry.keys()].sort();
}

function allowedKeys(): string[] {
  return [...workspaceAllowedKeys].sort();
}

function setOnlyAllowedKey(key: string): boolean {
  if (!capabilityRegistry.has(key)) {
    return false;
  }

  workspaceAllowedKeys.clear();
  workspaceAllowedKeys.add(key);
  return true;
}

async function runCapability(key: string, args: readonly string[]) {
  const capability = capabilityRegistry.get(key);

  if (capability === undefined) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `capability_not_registered: ${key}`,
        },
      ],
    };
  }

  if (!workspaceAllowedKeys.has(key)) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `capability_not_allowed: ${key}`,
        },
      ],
    };
  }

  const output = await capability.execute(args);

  return {
    content: [
      {
        type: "text" as const,
        text: output,
      },
    ],
  };
}

function registerRunCommand(server: McpServer): void {
  server.registerTool(
    "run_command",
    {
      title: "Run Junius Capability",
      description:
        "Run one Junius capability by key. The key must be registered on this machine and allowed by the current Workspace Profile. This tool does not accept executable paths or shell command strings.",
      inputSchema: z.object({
        key: z.string().min(1).describe("Registered Junius capability key."),
        args: z.array(z.string()).default([]).describe("Argument vector passed to the capability adapter."),
      }),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ key, args }) => runCapability(key, args),
  );
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "Junius",
    title: "Junius Fixed Tool Surface Spike",
    version: "0.2.0",
  });

  registerRunCommand(server);
  return server;
}

/**
 * Modern MCP (2026-07-28): every request uses the same fixed MCP tool schema.
 * Runtime authorization is read from workspaceAllowedKeys inside run_command.
 */
const modernHandler = createMcpHandler(() => createMcpServer(), {
  legacy: "reject",
  onerror(error) {
    console.error("[mcp modern]", error);
  },
});

/**
 * Legacy MCP clients use the same fixed tool surface. No tools/list_changed
 * notification is involved in this spike.
 */
const legacyServer = createMcpServer();
const legacyTransport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: randomUUID,
});

await legacyServer.connect(legacyTransport);

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
    sendJson(res, 200, {
      registeredKeys: registeredKeys(),
      allowedKeys: allowedKeys(),
    });
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/workspace/only/")) {
    const key = decodeURIComponent(url.pathname.slice("/workspace/only/".length));

    if (!setOnlyAllowedKey(key)) {
      sendJson(res, 400, {
        error: "capability_not_registered",
        key,
        registeredKeys: registeredKeys(),
      });
      return;
    }

    sendJson(res, 200, {
      allowedKeys: allowedKeys(),
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
