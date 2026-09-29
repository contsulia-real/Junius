import { watch, type FSWatcher } from "node:fs";
import {
  createServer as createHttpServer,
  type Server,
} from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHostConfig } from "./host-config.js";
import {
  JobHistoryStore,
  resolveJobHistoryPath,
  resolveJobHistoryRetention,
} from "./job-history-store.js";
import { sendHostJson } from "./host-http.js";
import { hostRequestRejection } from "./host-request-security.js";
import {
  sourceChangeDisposition,
  type HostWatchedArea,
} from "./host-source-boundary.js";
import {
  HostLatencyTraceStore,
  proxyToActiveWorker,
} from "./reverse-proxy.js";
import { WorkerSupervisor } from "./worker-supervisor.js";

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid_positive_integer: ${value}`);
  }

  return parsed;
}

async function listen(
  server: Server,
  port: number,
  host: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;

  await new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
  });
}

const config = loadHostConfig();
const cwd = process.cwd();
const publicMcpOrigin =
  `http://${config.mcpHost}:${config.mcpPort}`;

const jobHistory = new JobHistoryStore(
  resolveJobHistoryPath(),
  resolveJobHistoryRetention(),
);
await jobHistory.recoverInterrupted();

let hostRestartRequired = false;
let reloadTimer: NodeJS.Timeout | undefined;
let closing = false;

const supervisor = new WorkerSupervisor({
  cwd,
  publicMcpOrigin,
  rollbackWindowMs: parsePositiveInteger(
    process.env.JUNIUS_WORKER_ROLLBACK_MS,
    60_000,
  ),
  initialWorkerEntryPath: fileURLToPath(
    new URL("./worker-entry.ts", import.meta.url),
  ),
  workerEntryPath: resolve(cwd, "src", "worker-entry.ts"),
  canPromote: () => !hostRestartRequired,
  onWorkerExit: (workerId) => {
    jobHistory.recoverInterruptedSync(
      workerId,
    );
    void jobHistory.prune().catch(
      (error: unknown) => {
        console.error(
          "[host] job history prune after worker recovery failed",
          error,
        );
      },
    );
  },
});

await supervisor.startInitial();

const latencyTraces = new HostLatencyTraceStore(64);

function markHostRestartRequired(
  reason: string,
): void {
  if (hostRestartRequired) {
    return;
  }

  hostRestartRequired = true;

  if (reloadTimer !== undefined) {
    clearTimeout(reloadTimer);
    reloadTimer = undefined;
  }

  console.error(
    `[host] restart required: ${reason}`,
  );
}

function scheduleReload(reason: string): void {
  if (closing || hostRestartRequired) return;

  if (reloadTimer !== undefined) {
    clearTimeout(reloadTimer);
  }

  reloadTimer = setTimeout(() => {
    reloadTimer = undefined;

    if (hostRestartRequired) {
      return;
    }

    void supervisor.reload(reason).then((result) => {
      if (result.promoted) {
        console.error(
          `[host] promoted worker ${result.workerId}`,
        );
      } else {
        console.error(
          `[host] candidate rejected: ${result.reason}`,
        );
      }
    });
  }, 350);
}

function sourceChange(
  area: HostWatchedArea,
  fileName: string | Buffer | null,
): void {
  const relative =
    fileName === null
      ? undefined
      : fileName
          .toString()
          .replaceAll("\\", "/");

  const disposition = sourceChangeDisposition(
    resolve(cwd, "src"),
    area,
    relative,
  );

  if (disposition === "ignore") {
    return;
  }

  const reason =
    relative === undefined
      ? `${area}_changed`
      : `${area}/${relative}`;

  if (disposition === "restart-host") {
    markHostRestartRequired(reason);
    return;
  }

  scheduleReload(reason);
}

const watchers: FSWatcher[] = [
  watch(
    resolve(cwd, "src"),
    { recursive: true },
    (_eventType, fileName) => {
      sourceChange("src", fileName);
    },
  ),
  watch(
    resolve(cwd, "python"),
    { recursive: true },
    (_eventType, fileName) => {
      sourceChange("python", fileName);
    },
  ),
  watch(
    cwd,
    { recursive: false },
    (_eventType, fileName) => {
      sourceChange("root", fileName);
    },
  ),
  watch(
    resolve(cwd, "scripts"),
    { recursive: false },
    (_eventType, fileName) => {
      sourceChange("scripts", fileName);
    },
  ),
];

function allowPublicRequest(
  req: Parameters<typeof hostRequestRejection>[0],
  res: Parameters<typeof sendHostJson>[0],
  origin: string,
): boolean {
  const rejection =
    hostRequestRejection(req, origin);

  if (rejection === undefined) {
    return true;
  }

  sendHostJson(res, 403, {
    error: rejection,
  });
  return false;
}

const hostHttpServer = createHttpServer((req, res) => {
  if (
    !allowPublicRequest(
      req,
      res,
      publicMcpOrigin,
    )
  ) {
    return;
  }

  const pathname =
    new URL(
      req.url ?? "/",
      publicMcpOrigin,
    ).pathname;

  if (
    req.method === "GET" &&
    pathname ===
      "/__junius/supervisor"
  ) {
    sendHostJson(res, 200, {
      host: {
        pid: process.pid,
        uptimeSeconds:
          Math.floor(
            process.uptime(),
          ),
        restartRequired:
          hostRestartRequired,
        releaseId:
          process.env
            .JUNIUS_RELEASE_ID ??
          null,
      },
      supervisor:
        supervisor.state(),
      latencyTraces:
        latencyTraces.list(),
    });
    return;
  }

  if (
    req.method === "GET" &&
    pathname ===
      "/__junius/host-health"
  ) {
    sendHostJson(res, 200, {
      ok: true,
      pid: process.pid,
      activeWorkerId:
        supervisor.state()
          .activeWorkerId,
      releaseId:
        process.env
          .JUNIUS_RELEASE_ID ??
        null,
    });
    return;
  }

  if (pathname !== "/mcp") {
    sendHostJson(res, 404, {
      error: "not_found",
    });
    return;
  }

  proxyToActiveWorker(
    req,
    res,
    supervisor,
    latencyTraces,
  );
});

try {
  await listen(
    hostHttpServer,
    config.mcpPort,
    config.mcpHost,
  );
} catch (error) {
  for (const watcher of watchers) watcher.close();
  await Promise.allSettled([
    closeServer(hostHttpServer),
    supervisor.close(),
  ]);
  throw error;
}

console.error(
  `Junius Host: ${publicMcpOrigin}`,
);
console.error(
  `Junius MCP: ${publicMcpOrigin}/mcp`,
);
console.error(
  `Junius Health: ${publicMcpOrigin}/__junius/host-health`,
);
console.error(
  `Junius Supervisor: ${publicMcpOrigin}/__junius/supervisor`,
);

async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;

  console.error(
    `Received ${signal}; shutting down Junius Host.`,
  );

  if (reloadTimer !== undefined) {
    clearTimeout(reloadTimer);
    reloadTimer = undefined;
  }

  for (const watcher of watchers) watcher.close();

  await Promise.allSettled([
    closeServer(hostHttpServer),
  ]);
  await supervisor.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => {
      process.exit(0);
    });
  });
}
