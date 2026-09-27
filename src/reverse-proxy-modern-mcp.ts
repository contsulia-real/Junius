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
} from "./reverse-proxy-routing.js";
import type { HostLatencyTraceStore } from "./reverse-proxy-trace.js";
import {
  copyResponseHeaders,
  forwardedRequestHeaders,
  headerDurationMs,
  readBody,
} from "./reverse-proxy-http.js";

const MAX_CAPTURED_TOOL_RESPONSE_BYTES = 1024 * 1024;

export async function proxyModernMcp(
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
