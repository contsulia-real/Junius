import { watch, type FSWatcher } from "node:fs";
import {
  createServer as createHttpServer,
  type Server,
} from "node:http";
import { resolve } from "node:path";
import { loadHostConfig } from "./host-config.js";
import { sendHostJson } from "./host-http.js";
import { proxyToActiveWorker } from "./reverse-proxy.js";
import { WorkerSupervisor } from "./worker-supervisor.js";

const HOST_ONLY_FILES = new Set([
  "host-config.ts",
  "host-http.ts",
  "host.ts",
  "reverse-proxy.ts",
  "source-check.ts",
  "worker-process.ts",
  "worker-supervisor.ts",
]);

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
const publicAdminOrigin =
  `http://${config.adminHost}:${config.adminPort}`;

const supervisor = new WorkerSupervisor({
  cwd,
  publicMcpOrigin,
  publicAdminOrigin,
  rollbackWindowMs: parsePositiveInteger(
    process.env.JUNIUS_WORKER_ROLLBACK_MS,
    60_000,
  ),
});

await supervisor.startInitial();

let hostRestartRequired = false;
let reloadTimer: NodeJS.Timeout | undefined;
let closing = false;

function scheduleReload(reason: string): void {
  if (closing) return;

  if (reloadTimer !== undefined) {
    clearTimeout(reloadTimer);
  }

  reloadTimer = setTimeout(() => {
    reloadTimer = undefined;
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
  area: "src" | "python",
  fileName: string | Buffer | null,
): void {
  if (fileName === null) {
    scheduleReload(`${area}_changed`);
    return;
  }

  const relative = fileName.toString().replaceAll("\\", "/");

  if (relative.endsWith(".test.ts")) {
    return;
  }

  if (
    area === "src" &&
    HOST_ONLY_FILES.has(relative)
  ) {
    hostRestartRequired = true;
    console.error(
      `[host] host-only source changed; restart required: src/${relative}`,
    );
    return;
  }

  if (
    (area === "src" && relative.endsWith(".ts")) ||
    (area === "python" && relative.endsWith(".py"))
  ) {
    scheduleReload(`${area}/${relative}`);
  }
}

const watchers: FSWatcher[] = [];
for (const area of ["src", "python"] as const) {
  watchers.push(
    watch(
      resolve(cwd, area),
      { recursive: true },
      (_eventType, fileName) => {
        sourceChange(area, fileName);
      },
    ),
  );
}

const mcpHttpServer = createHttpServer((req, res) => {
  proxyToActiveWorker(req, res, supervisor, "mcp");
});

const adminHttpServer = createHttpServer((req, res) => {
  if (
    req.method === "GET" &&
    req.url === "/__junius/supervisor"
  ) {
    sendHostJson(res, 200, {
      host: {
        pid: process.pid,
        uptimeSeconds: Math.floor(process.uptime()),
        restartRequired: hostRestartRequired,
      },
      supervisor: supervisor.state(),
    });
    return;
  }

  if (
    req.method === "GET" &&
    req.url === "/__junius/host-health"
  ) {
    sendHostJson(res, 200, {
      ok: true,
      pid: process.pid,
      activeWorkerId: supervisor.state().activeWorkerId,
    });
    return;
  }

  proxyToActiveWorker(req, res, supervisor, "admin");
});

try {
  await listen(
    mcpHttpServer,
    config.mcpPort,
    config.mcpHost,
  );
  await listen(
    adminHttpServer,
    config.adminPort,
    config.adminHost,
  );
} catch (error) {
  for (const watcher of watchers) watcher.close();
  await Promise.allSettled([
    closeServer(mcpHttpServer),
    closeServer(adminHttpServer),
    supervisor.close(),
  ]);
  throw error;
}

console.error(`Junius Host MCP: ${publicMcpOrigin}/mcp`);
console.error(`Junius Host WebUI: ${publicAdminOrigin}/`);
console.error(
  `Junius Supervisor: ${publicAdminOrigin}/__junius/supervisor`,
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
    closeServer(mcpHttpServer),
    closeServer(adminHttpServer),
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
