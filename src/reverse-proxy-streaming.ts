import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Transform } from "node:stream";
import { sendHostJson } from "./host-http.js";
import { WORKER_AUTH_HEADER } from "./worker-auth.js";
import type { WorkerSupervisor } from "./worker-supervisor.js";
import { isConfigurationMutationRequest } from "./reverse-proxy-routing.js";
import {
  MAX_MCP_REQUEST_BYTES,
  copyResponseHeaders,
  forwardedRequestHeaders,
  headerString,
} from "./reverse-proxy-http.js";

export function proxyStreaming(
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
  const configurationMutation =
    kind === "admin" &&
    isConfigurationMutationRequest(req);

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
      const statusCode = upstreamResponse.statusCode ?? 502;
      const shouldSynchronizeConfiguration =
        configurationMutation &&
        statusCode >= 200 &&
        statusCode < 300;

      if (shouldSynchronizeConfiguration) {
        const chunks: Buffer[] = [];
        let settled = false;

        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;

          void supervisor
            .synchronizeConfiguration(worker.id)
            .then(() => {
              if (error !== undefined) {
                if (!res.headersSent) {
                  sendHostJson(res, 502, {
                    error: "worker_proxy_failed",
                    message: error.message,
                  });
                } else {
                  res.destroy(error);
                }
                return;
              }

              if (res.destroyed) return;
              res.statusCode = statusCode;
              copyResponseHeaders(upstreamResponse.headers, res);
              res.end(Buffer.concat(chunks));
            })
            .catch((syncError: unknown) => {
              if (res.destroyed) return;
              sendHostJson(res, 503, {
                error: "configuration_sync_failed",
                message:
                  syncError instanceof Error
                    ? syncError.message
                    : String(syncError),
              });
            })
            .finally(release);
        };

        upstreamResponse.on("data", (chunk: Buffer | string) => {
          chunks.push(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
          );
        });
        upstreamResponse.once("end", () => finish());
        upstreamResponse.once("error", (error) => finish(error));
        res.once("close", release);
        return;
      }

      res.statusCode = statusCode;
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
