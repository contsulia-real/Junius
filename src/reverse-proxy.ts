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
