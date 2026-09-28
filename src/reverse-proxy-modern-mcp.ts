import { randomUUID } from "node:crypto";
import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { sendHostJson } from "./host-http.js";
import { WORKER_AUTH_HEADER } from "./worker-auth.js";
import type { WorkerSupervisor } from "./worker-supervisor.js";
import {
  bindBeforeForward,
  extractStartedJobId,
  parseToolCall,
  releaseAfterForward,
  routeKeyForTool,
  toolCallSucceeded,
} from "./reverse-proxy-routing.js";
import type { HostLatencyTraceStore } from "./reverse-proxy-trace.js";
import {
  copyResponseHeaders,
  forwardedRequestHeaders,
  headerDurationMs,
  headerString,
  readBody,
} from "./reverse-proxy-http.js";

const MAX_CAPTURED_TOOL_RESPONSE_BYTES = 1024 * 1024;

export async function proxyModernMcp(
  req: IncomingMessage,
  res: ServerResponse,
  supervisor: WorkerSupervisor,
  traces?: HostLatencyTraceStore,
  requestSessionId?: string,
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
    lease = supervisor.acquire(
      requestSessionId,
      routeKey,
    );
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
  const desktopCommand =
    call?.name === "desktop"
      ? call.arguments.command
      : undefined;
  const captureDesktopLifecycle =
    desktopCommand === "control_begin" ||
    desktopCommand === "control_end";
  const captureWorkspaceMutation =
    call?.name === "create_workspace" ||
    call?.name === "delete_workspace";
  const captureToolResponse =
    captureStartJob ||
    captureDesktopLifecycle ||
    captureWorkspaceMutation;

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

      const responseSessionId =
        headerString(
          upstreamResponse.headers["mcp-session-id"],
        );
      if (responseSessionId !== undefined) {
        supervisor.bindSession(
          responseSessionId,
          worker.id,
        );
      }

      if (!captureToolResponse) {
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
      let capturedBytes = 0;
      let captureExceeded = false;

      upstreamResponse.on("data", (chunk: Buffer | string) => {
        if (captureExceeded) return;

        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk);
        capturedBytes += buffer.length;

        if (
          capturedBytes >
          MAX_CAPTURED_TOOL_RESPONSE_BYTES
        ) {
          captureExceeded = true;
          upstreamResponse.destroy();
          res.removeHeader("content-length");
          sendHostJson(res, 502, {
            error: "worker_response_too_large",
          });
          recordTrace(502);
          lease.release();
          return;
        }

        chunks.push(buffer);
      });
      upstreamResponse.once("end", () => {
        if (captureExceeded) return;
        const responseBody = Buffer.concat(chunks);
        const responseText =
          responseBody.toString("utf8");

        void (async () => {
          try {
            if (captureStartJob) {
              const jobId = extractStartedJobId(
                responseText,
              );

              if (jobId !== undefined) {
                supervisor.bindResource(
                  `job:${jobId}`,
                  worker.id,
                );
              }
            }

            if (
              captureWorkspaceMutation &&
              toolCallSucceeded(responseText)
            ) {
              await supervisor
                .synchronizeConfiguration(
                  worker.id,
                );
            }

            if (
              captureDesktopLifecycle &&
              toolCallSucceeded(responseText)
            ) {
              const session =
                typeof call?.arguments.session === "string"
                  ? call.arguments.session
                  : "junius";
              const resourceKey =
                `desktop:${session}`;

              if (desktopCommand === "control_begin") {
                supervisor.bindResource(
                  resourceKey,
                  worker.id,
                );
              } else {
                supervisor.releaseResource(
                  resourceKey,
                );
              }
            }

            releaseAfterForward(
              supervisor,
              call,
            );
            if (!res.destroyed) {
              res.end(responseBody);
            }
            recordTrace(statusCode);
          } catch (error) {
            if (!res.destroyed) {
              res.removeHeader(
                "content-length",
              );
              sendHostJson(
                res,
                503,
                {
                  error:
                    "configuration_sync_failed",
                  message:
                    error instanceof Error
                      ? error.message
                      : String(error),
                },
              );
            }
            recordTrace(503);
          } finally {
            lease.release();
          }
        })();
      });
      upstreamResponse.once("error", (error) => {
        if (captureExceeded) return;
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
