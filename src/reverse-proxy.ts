import { randomUUID } from "node:crypto";
import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { WorkerSupervisor } from "./worker-supervisor.js";
import { headerString } from "./reverse-proxy-http.js";
import { proxyModernMcp } from "./reverse-proxy-modern-mcp.js";
import { proxyStreaming } from "./reverse-proxy-streaming.js";
import type { HostLatencyTraceStore } from "./reverse-proxy-trace.js";

export {
  HostLatencyTraceStore,
  type HostLatencyTrace,
} from "./reverse-proxy-trace.js";

export function proxyToActiveWorker(
  req: IncomingMessage,
  res: ServerResponse,
  supervisor: WorkerSupervisor,
  traces?: HostLatencyTraceStore,
): void {
  const requestSessionId =
    headerString(
      req.headers["mcp-session-id"],
    );
  const traceId = randomUUID();

  traces?.start(traceId, {
    method: req.method,
    path: req.url,
    ...(requestSessionId === undefined
      ? {}
      : { sessionId: requestSessionId }),
  });
  res.setHeader("x-junius-trace-id", traceId);

  req.once("aborted", () => {
    traces?.event(traceId, "client_request_aborted");
    traces?.finish(
      traceId,
      "client_aborted",
      res.headersSent ? res.statusCode : undefined,
    );
  });
  req.once("error", (error) => {
    traces?.event(
      traceId,
      "client_request_error",
      error.message,
    );
    traces?.finish(
      traceId,
      "client_aborted",
      res.headersSent ? res.statusCode : undefined,
      error.message,
    );
  });
  res.once("finish", () => {
    traces?.event(traceId, "response_finished");
    traces?.finish(
      traceId,
      "completed",
      res.statusCode,
    );
  });
  res.once("close", () => {
    if (res.writableFinished) return;
    traces?.event(traceId, "response_closed");
    traces?.finish(
      traceId,
      "client_disconnected",
      res.headersSent ? res.statusCode : undefined,
    );
  });
  res.once("error", (error) => {
    traces?.event(
      traceId,
      "response_error",
      error.message,
    );
    traces?.finish(
      traceId,
      "response_error",
      res.headersSent ? res.statusCode : undefined,
      error.message,
    );
  });

  if (req.method === "POST") {
    void proxyModernMcp(
      req,
      res,
      supervisor,
      traces,
      requestSessionId,
      traceId,
    );
    return;
  }

  proxyStreaming(
    req,
    res,
    supervisor,
    requestSessionId,
    traces,
    traceId,
  );
}
