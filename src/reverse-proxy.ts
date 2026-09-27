import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { sendHostJson } from "./host-http.js";
import { WorkerSupervisor } from "./worker-supervisor.js";

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

function headerString(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function proxyToActiveWorker(
  req: IncomingMessage,
  res: ServerResponse,
  supervisor: WorkerSupervisor,
  kind: "mcp" | "admin",
): void {
  const requestSessionId =
    kind === "mcp"
      ? headerString(req.headers["mcp-session-id"])
      : undefined;

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

  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port,
      method: req.method,
      path: req.url,
      headers: req.headers,
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
  req.pipe(upstream);
}
