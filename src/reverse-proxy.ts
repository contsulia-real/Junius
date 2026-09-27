import { randomUUID } from "node:crypto";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Transform } from "node:stream";
import { sendHostJson } from "./host-http.js";
import { WORKER_AUTH_HEADER } from "./worker-auth.js";
import { WorkerSupervisor } from "./worker-supervisor.js";

const MAX_MCP_REQUEST_BYTES = 16 * 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface McpToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface HostLatencyTrace {
  readonly traceId: string;
  readonly tool?: string;
  readonly workerId?: string;
  readonly statusCode: number;
  readonly hostTotalMs: number;
  readonly workerDurationMs?: number;
  readonly proxyOverheadMs?: number;
  readonly completedAt: string;
}

export class HostLatencyTraceStore {
  readonly #limit: number;
  #entries: HostLatencyTrace[] = [];

  constructor(limit = 64) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  record(trace: HostLatencyTrace): void {
    this.#entries.push(trace);
    if (this.#entries.length > this.#limit) {
      this.#entries.splice(
        0,
        this.#entries.length - this.#limit,
      );
    }
  }

  list(): readonly HostLatencyTrace[] {
    return [...this.#entries].reverse();
  }
}

function copyResponseHeaders(
  headers: IncomingHttpHeaders,
  res: ServerResponse,
): void {
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(name.toLowerCase())
    ) {
      continue;
    }

    res.setHeader(name, value);
  }
}

function forwardedRequestHeaders(
  headers: IncomingHttpHeaders,
  contentLength?: number,
): IncomingHttpHeaders {
  const next: IncomingHttpHeaders = {};

  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(name.toLowerCase()) ||
      name.toLowerCase() === WORKER_AUTH_HEADER
    ) {
      continue;
    }
    next[name] = value;
  }

  if (contentLength !== undefined) {
    next["content-length"] = String(contentLength);
  }

  return next;
}

function headerString(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function headerDurationMs(
  value: string | string[] | undefined,
): number | undefined {
  const text = headerString(value);
  if (text === undefined) return undefined;

  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

async function readBody(
  req: IncomingMessage,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);

    bytes += buffer.length;
    if (bytes > MAX_MCP_REQUEST_BYTES) {
      throw new Error("mcp_request_too_large");
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function parseToolCall(body: Buffer): McpToolCall | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return undefined;
  }

  const message = parsed as {
    method?: unknown;
    params?: unknown;
  };

  if (
    message.method !== "tools/call" ||
    typeof message.params !== "object" ||
    message.params === null
  ) {
    return undefined;
  }

  const params = message.params as {
    name?: unknown;
    arguments?: unknown;
  };

  if (typeof params.name !== "string") {
    return undefined;
  }

  return {
    name: params.name,
    arguments:
      typeof params.arguments === "object" &&
      params.arguments !== null &&
      !Array.isArray(params.arguments)
        ? params.arguments as Record<string, unknown>
        : {},
  };
}

function argumentString(
  call: McpToolCall,
  key: string,
  fallback?: string,
): string | undefined {
  const value = call.arguments[key];
  return typeof value === "string" ? value : fallback;
}

function routeKeyForTool(
  call: McpToolCall | undefined,
): string | undefined {
  if (call === undefined) return undefined;

  if (
    ["get_job", "wait_job", "read_job_output", "cancel_job"].includes(
      call.name,
    )
  ) {
    const job = argumentString(call, "job");
    return job === undefined ? undefined : `job:${job}`;
  }

  if (call.name === "playwright_cli") {
    const session = argumentString(call, "session", "junius")!;
    return `browser:${session}`;
  }

  if (call.name === "desktop") {
    const command = argumentString(call, "command");
    if (
      ["invoke", "set_value", "focus"].includes(command ?? "")
    ) {
      const session = argumentString(call, "session", "junius")!;
      return `desktop:${session}`;
    }
  }

  return undefined;
}

function bindBeforeForward(
  supervisor: WorkerSupervisor,
  call: McpToolCall | undefined,
  workerId: string,
): void {
  if (call === undefined) return;

  if (call.name === "playwright_cli") {
    const command = argumentString(call, "command");
    if (command !== "close") {
      const session = argumentString(call, "session", "junius")!;
      supervisor.bindResource(
        `browser:${session}`,
        workerId,
      );
    }
    return;
  }

  if (
    call.name === "desktop" &&
    argumentString(call, "command") === "inspect"
  ) {
    const session = argumentString(call, "session", "junius")!;
    supervisor.bindResource(
      `desktop:${session}`,
      workerId,
    );
  }
}

function releaseAfterForward(
  supervisor: WorkerSupervisor,
  call: McpToolCall | undefined,
): void {
  if (
    call?.name === "playwright_cli" &&
    argumentString(call, "command") === "close"
  ) {
    const session = argumentString(call, "session", "junius")!;
    supervisor.releaseResource(`browser:${session}`);
  }
}

function jsonRpcMessages(
  body: string,
): readonly unknown[] {
  const messages: unknown[] = [];

  try {
    messages.push(JSON.parse(body) as unknown);
  } catch {
    for (const line of body.split(/\r?\n/u)) {
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        messages.push(JSON.parse(payload) as unknown);
      } catch {
        // Ignore malformed/non-JSON SSE events.
      }
    }
  }

  return messages;
}

function extractStartedJobId(
  responseBody: string,
): string | undefined {
  for (const message of jsonRpcMessages(responseBody)) {
    if (
      typeof message !== "object" ||
      message === null ||
      !("result" in message)
    ) {
      continue;
    }

    const result = (
      message as {
        result?: {
          content?: unknown;
        };
      }
    ).result;

    if (!Array.isArray(result?.content)) {
      continue;
    }

    for (const item of result.content) {
      if (
        typeof item !== "object" ||
        item === null ||
        (item as { type?: unknown }).type !== "text" ||
        typeof (item as { text?: unknown }).text !== "string"
      ) {
        continue;
      }

      try {
        const payload = JSON.parse(
          (item as { text: string }).text,
        ) as {
          ok?: unknown;
          job?: {
            id?: unknown;
          };
        };

        if (
          payload.ok === true &&
          typeof payload.job?.id === "string"
        ) {
          return payload.job.id;
        }
      } catch {
        // This text content is not the start_job JSON payload.
      }
    }
  }

  return undefined;
}

function proxyStreaming(
  req: IncomingMessage,
  res: ServerResponse,
  supervisor: WorkerSupervisor,
  kind: "mcp" | "admin",
  requestSessionId?: string,
): void {
  let lease;
  try {
    lease = supervisor.acquire(requestSessionId);
  } catch (error) {
    sendHostJson(res, 503, {
      error: "no_active_worker",
      message:
        error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const worker = lease.worker;
  const port =
    kind === "mcp" ? worker.mcpPort : worker.adminPort;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lease.release();
  };

  let requestTooLarge = false;

  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port,
      method: req.method,
      path: req.url,
      headers: {
        ...forwardedRequestHeaders(req.headers),
        [WORKER_AUTH_HEADER]:
          worker.internalToken,
      },
    },
    (upstreamResponse) => {
      res.statusCode = upstreamResponse.statusCode ?? 502;
      copyResponseHeaders(upstreamResponse.headers, res);

      const responseSessionId =
        kind === "mcp"
          ? headerString(
              upstreamResponse.headers["mcp-session-id"],
            )
          : undefined;

      if (responseSessionId !== undefined) {
        supervisor.bindSession(
          responseSessionId,
          worker.id,
        );
      }

      upstreamResponse.pipe(res);

      upstreamResponse.once("end", () => {
        if (
          kind === "mcp" &&
          req.method === "DELETE" &&
          requestSessionId !== undefined
        ) {
          supervisor.releaseSession(requestSessionId);
        }
        release();
      });
      upstreamResponse.once("error", (error) => {
        res.destroy(error);
        release();
      });
      res.once("close", release);
    },
  );

  upstream.once("error", (error) => {
    if (requestTooLarge) {
      release();
      return;
    }

    if (!res.headersSent) {
      sendHostJson(res, 502, {
        error: "worker_proxy_failed",
        message: error.message,
      });
    } else {
      res.destroy(error);
    }
    release();
  });

  req.once("aborted", () => {
    upstream.destroy();
    release();
  });

  let requestBytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk);
      requestBytes += buffer.length;

      if (requestBytes > MAX_MCP_REQUEST_BYTES) {
        callback(
          new Error("mcp_request_too_large"),
        );
        return;
      }

      callback(null, buffer);
    },
  });

  limiter.once("error", () => {
    requestTooLarge = true;
    req.unpipe(limiter);
    upstream.destroy();

    if (!res.headersSent) {
      sendHostJson(res, 413, {
        error: "mcp_request_too_large",
      });
    } else {
      res.destroy();
    }

    req.resume();
    release();
  });

  req.pipe(limiter).pipe(upstream);
}

async function proxyModernMcp(
  req: IncomingMessage,
  res: ServerResponse,
  supervisor: WorkerSupervisor,
  traces?: HostLatencyTraceStore,
): Promise<void> {
  const startedAt = performance.now();
  const traceId = randomUUID();
  let toolName: string | undefined;
  let traceWorkerId: string | undefined;
  let workerDurationMs: number | undefined;
  let traceRecorded = false;

  const recordTrace = (statusCode: number) => {
    if (traceRecorded) return;
    traceRecorded = true;

    const hostTotalMs = Math.round(
      performance.now() - startedAt,
    );

    traces?.record({
      traceId,
      ...(toolName === undefined
        ? {}
        : { tool: toolName }),
      ...(traceWorkerId === undefined
        ? {}
        : { workerId: traceWorkerId }),
      statusCode,
      hostTotalMs,
      ...(workerDurationMs === undefined
        ? {}
        : {
            workerDurationMs,
            proxyOverheadMs: Math.max(
              0,
              hostTotalMs - workerDurationMs,
            ),
          }),
      completedAt: new Date().toISOString(),
    });
  };

  let body: Buffer;

  try {
    body = await readBody(req);
  } catch (error) {
    const statusCode =
      error instanceof Error &&
      error.message === "mcp_request_too_large"
        ? 413
        : 400;

    sendHostJson(res, statusCode, {
      error:
        error instanceof Error
          ? error.message
          : "invalid_mcp_request",
    });
    recordTrace(statusCode);
    return;
  }

  const call = parseToolCall(body);
  toolName = call?.name;
  const routeKey = routeKeyForTool(call);

  let lease;
  try {
    lease = supervisor.acquire(undefined, routeKey);
  } catch (error) {
    sendHostJson(res, 503, {
      error: "no_active_worker",
      message:
        error instanceof Error ? error.message : String(error),
    });
    recordTrace(503);
    return;
  }

  const worker = lease.worker;
  traceWorkerId = worker.id;
  bindBeforeForward(supervisor, call, worker.id);

  const captureStartJob = call?.name === "start_job";

  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: worker.mcpPort,
      method: req.method,
      path: req.url,
      headers: {
        ...forwardedRequestHeaders(
          req.headers,
          body.length,
        ),
        "x-junius-trace-id": traceId,
        [WORKER_AUTH_HEADER]:
          worker.internalToken,
      },
    },
    (upstreamResponse) => {
      const statusCode =
        upstreamResponse.statusCode ?? 502;
      res.statusCode = statusCode;
      workerDurationMs = headerDurationMs(
        upstreamResponse.headers[
          "x-junius-worker-duration-ms"
        ],
      );
      copyResponseHeaders(upstreamResponse.headers, res);
      res.setHeader("x-junius-trace-id", traceId);

      if (!captureStartJob) {
        upstreamResponse.pipe(res);
        upstreamResponse.once("end", () => {
          releaseAfterForward(supervisor, call);
          recordTrace(statusCode);
          lease.release();
        });
        upstreamResponse.once("error", (error) => {
          recordTrace(502);
          res.destroy(error);
          lease.release();
        });
        return;
      }

      const chunks: Buffer[] = [];
      upstreamResponse.on("data", (chunk: Buffer | string) => {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        );
      });
      upstreamResponse.once("end", () => {
        const responseBody = Buffer.concat(chunks);
        const jobId = extractStartedJobId(
          responseBody.toString("utf8"),
        );

        if (jobId !== undefined) {
          supervisor.bindResource(
            `job:${jobId}`,
            worker.id,
          );
        }

        releaseAfterForward(supervisor, call);
        res.end(responseBody);
        recordTrace(statusCode);
        lease.release();
      });
      upstreamResponse.once("error", (error) => {
        recordTrace(502);
        res.destroy(error);
        lease.release();
      });
    },
  );

  upstream.once("error", (error) => {
    if (!res.headersSent) {
      sendHostJson(res, 502, {
        error: "worker_proxy_failed",
        message: error.message,
      });
    } else {
      res.destroy(error);
    }
    recordTrace(502);
    lease.release();
  });

  upstream.end(body);
}

export function proxyToActiveWorker(
  req: IncomingMessage,
  res: ServerResponse,
  supervisor: WorkerSupervisor,
  kind: "mcp" | "admin",
  traces?: HostLatencyTraceStore,
): void {
  const requestSessionId =
    kind === "mcp"
      ? headerString(req.headers["mcp-session-id"])
      : undefined;

  if (
    kind === "mcp" &&
    req.method === "POST" &&
    requestSessionId === undefined
  ) {
    void proxyModernMcp(
      req,
      res,
      supervisor,
      traces,
    );
    return;
  }

  proxyStreaming(
    req,
    res,
    supervisor,
    kind,
    requestSessionId,
  );
}
