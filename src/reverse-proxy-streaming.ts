import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Transform } from "node:stream";
import { sendHostJson } from "./host-http.js";
import { WORKER_AUTH_HEADER } from "./worker-auth.js";
import type { WorkerSupervisor } from "./worker-supervisor.js";
import type { HostLatencyTraceStore } from "./reverse-proxy-trace.js";
import {
  MAX_MCP_REQUEST_BYTES,
  copyResponseHeaders,
  forwardedRequestHeaders,
  headerDurationMs,
  headerString,
} from "./reverse-proxy-http.js";

export function proxyStreaming(
  req: IncomingMessage,
  res: ServerResponse,
  supervisor: WorkerSupervisor,
  requestSessionId: string | undefined,
  traces: HostLatencyTraceStore | undefined,
  traceId: string,
): void {
  let lease;
  try {
    lease = supervisor.acquire(
      requestSessionId,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);
    traces?.event(
      traceId,
      "worker_acquire_failed",
      message,
    );
    traces?.finish(
      traceId,
      "no_active_worker",
      503,
      message,
    );
    sendHostJson(res, 503, {
      error: "no_active_worker",
      message,
    });
    return;
  }

  const worker = lease.worker;
  traces?.annotate(traceId, {
    workerId: worker.id,
  });
  traces?.event(traceId, "worker_acquired", worker.id);
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
      port: worker.mcpPort,
      method: req.method,
      path: req.url,
      headers: {
        ...forwardedRequestHeaders(
          req.headers,
        ),
        "x-junius-trace-id": traceId,
        [WORKER_AUTH_HEADER]:
          worker.internalToken,
      },
    },
    (upstreamResponse) => {
      const statusCode =
        upstreamResponse.statusCode ??
        502;
      res.statusCode =
        statusCode;
      const workerDurationMs = headerDurationMs(
        upstreamResponse.headers[
          "x-junius-worker-duration-ms"
        ],
      );
      traces?.annotate(traceId, {
        statusCode,
        responseStartedAt: new Date().toISOString(),
        ...(workerDurationMs === undefined
          ? {}
          : { workerDurationMs }),
      });
      traces?.event(
        traceId,
        "worker_response_started",
        String(statusCode),
      );
      copyResponseHeaders(
        upstreamResponse.headers,
        res,
      );
      res.setHeader("x-junius-trace-id", traceId);

      const responseSessionId =
        headerString(
          upstreamResponse.headers[
            "mcp-session-id"
          ],
        );

      if (
        responseSessionId !==
        undefined
      ) {
        supervisor.bindSession(
          responseSessionId,
          worker.id,
        );
      }

      upstreamResponse.pipe(res);

      upstreamResponse.once(
        "end",
        () => {
          traces?.event(traceId, "worker_response_ended");
          if (
            req.method ===
              "DELETE" &&
            requestSessionId !==
              undefined
          ) {
            supervisor
              .releaseSession(
                requestSessionId,
              );
          }
          release();
        },
      );
      upstreamResponse.once(
        "error",
        (error) => {
          traces?.event(
            traceId,
            "worker_response_error",
            error.message,
          );
          traces?.finish(
            traceId,
            "upstream_error",
            502,
            error.message,
          );
          res.destroy(error);
          release();
        },
      );
      res.once(
        "close",
        release,
      );
    },
  );

  upstream.once(
    "error",
    (error) => {
      if (requestTooLarge) {
        release();
        return;
      }

      traces?.event(
        traceId,
        "worker_request_error",
        error.message,
      );
      traces?.finish(
        traceId,
        "upstream_error",
        502,
        error.message,
      );
      if (!res.headersSent) {
        sendHostJson(
          res,
          502,
          {
            error:
              "worker_proxy_failed",
            message:
              error.message,
          },
        );
      } else {
        res.destroy(error);
      }
      release();
    },
  );

  req.once(
    "aborted",
    () => {
      upstream.destroy();
      release();
    },
  );

  let requestBytes = 0;
  const limiter =
    new Transform({
      transform(
        chunk,
        _encoding,
        callback,
      ) {
        const buffer =
          Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk);
        requestBytes +=
          buffer.length;

        if (
          requestBytes >
          MAX_MCP_REQUEST_BYTES
        ) {
          callback(
            new Error(
              "mcp_request_too_large",
            ),
          );
          return;
        }

        callback(
          null,
          buffer,
        );
      },
    });

  limiter.once(
    "error",
    () => {
      requestTooLarge = true;
      traces?.event(
        traceId,
        "request_rejected",
        "mcp_request_too_large",
      );
      traces?.finish(
        traceId,
        "request_rejected",
        413,
        "mcp_request_too_large",
      );
      req.unpipe(limiter);
      upstream.destroy();

      if (!res.headersSent) {
        sendHostJson(
          res,
          413,
          {
            error:
              "mcp_request_too_large",
          },
        );
      } else {
        res.destroy();
      }

      req.resume();
      release();
    },
  );

  traces?.event(traceId, "worker_request_sent");
  req.pipe(limiter)
    .pipe(upstream);
}
