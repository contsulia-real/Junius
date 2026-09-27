import { loadRuntimeConfig } from "./config.js";
import { startAgentWorker } from "./agent-worker.js";

interface ShutdownMessage {
  readonly type: "junius-worker-shutdown";
}

const workerId =
  process.env.JUNIUS_WORKER_ID ??
  `worker-${process.pid}`;

let worker:
  | Awaited<ReturnType<typeof startAgentWorker>>
  | undefined;
let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  await worker?.close();
}

try {
  const config = await loadRuntimeConfig();
  const publicMcpOrigin =
    process.env.JUNIUS_PUBLIC_MCP_ORIGIN ??
    `http://${config.mcpHost}:${config.mcpPort}`;
  const publicAdminOrigin =
    process.env.JUNIUS_PUBLIC_ADMIN_ORIGIN ??
    `http://${config.adminHost}:${config.adminPort}`;

  worker = await startAgentWorker({
    config,
    workerId,
    mcpListenPort: 0,
    adminListenPort: 0,
    publicMcpOrigin,
    publicAdminOrigin,
    onJobTerminal: (job) => {
      process.send?.({
        type: "junius-job-terminal",
        workerId,
        jobId: job.id,
        status: job.status,
      });
    },
  });

  process.send?.({
    type: "junius-worker-ready",
    workerId,
    pid: process.pid,
    mcpPort: worker.mcpPort,
    adminPort: worker.adminPort,
  });
} catch (error) {
  process.send?.({
    type: "junius-worker-startup-error",
    workerId,
    message:
      error instanceof Error ? error.stack ?? error.message : String(error),
  });
  console.error(error);
  process.exitCode = 1;
}

process.on("message", (message: unknown) => {
  const candidate = message as Partial<ShutdownMessage> | null;
  if (candidate?.type !== "junius-worker-shutdown") return;

  void shutdown().finally(() => {
    process.exit(0);
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => {
      process.exit(0);
    });
  });
}
