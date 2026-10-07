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
  traces: HostLatencyTraceStore | undefined,
  requestSessionId: string | undefined,
  traceId: string,
): Promise<void> {

  let body: Buffer;

  try {
    body = await readBody(req);
  } catch (error) {
    const statusCode =
      error instanceof Error &&
      error.message === "mcp_request_too_large"
        ? 413
        : 400;
    const message =
      error instanceof Error
        ? error.message
        : "invalid_mcp_request";

    traces?.event(traceId, "request_rejected", message);
    traces?.finish(
      traceId,
      "request_rejected",
      statusCode,
      message,
    );
    sendHostJson(res, statusCode, {
      error: message,
    });
    return;
  }

  const call = parseToolCall(body);
  traces?.annotate(traceId, {
    ...(call?.name === undefined
      ? {}
      : { tool: call.name }),
  });
  const routeKey = routeKeyForTool(call);

  let lease;
  try {
    lease = supervisor.acquire(
      requestSessionId,
      routeKey,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
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
          traces?.event(traceId, "worker_response_ended");
          releaseAfterForward(supervisor, call);
          lease.release();
        });
        upstreamResponse.once("error", (error) => {
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
          traces?.event(
            traceId,
            "worker_response_too_large",
          );
          traces?.finish(
            traceId,
            "host_error",
            502,
            "worker_response_too_large",
          );
          upstreamResponse.destroy();
          res.removeHeader("content-length");
          sendHostJson(res, 502, {
            error: "worker_response_too_large",
          });
          lease.release();
          return;
        }

        chunks.push(buffer);
      });
      upstreamResponse.once("end", () => {
        traces?.event(traceId, "worker_response_ended");
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
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : String(error);
            traces?.event(
              traceId,
              "host_postprocess_error",
              message,
            );
            traces?.finish(
              traceId,
              "host_error",
              503,
              message,
            );
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
                  message,
                },
              );
            }
          } finally {
            lease.release();
          }
        })();
      });
      upstreamResponse.once("error", (error) => {
        if (captureExceeded) return;
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
        lease.release();
      });
    },
  );

  upstream.once("error", (error) => {
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
      sendHostJson(res, 502, {
        error: "worker_proxy_failed",
        message: error.message,
      });
    } else {
      res.destroy(error);
    }
    lease.release();
  });

  traces?.event(traceId, "worker_request_sent");
  upstream.end(body);
}
