import { loadRuntimeConfig } from "./config.js";
import { startAgentWorker } from "./agent-worker.js";

interface ShutdownMessage {
  readonly type: "junius-worker-shutdown";
}

const workerId =
  process.env.JUNIUS_WORKER_ID ??
  `worker-${process.pid}`;
const internalToken =
  process.env.JUNIUS_WORKER_TOKEN;

if (
  internalToken === undefined ||
  internalToken.length < 32
) {
  throw new Error(
    "worker_internal_token_missing",
  );
}

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
  worker = await startAgentWorker({
    config,
    workerId,
    mcpListenPort: 0,
    controlListenPort: 0,
    publicMcpOrigin,
    internalToken,
    onJobTerminal: (job) => {
      process.send?.({
        type: "junius-job-terminal",
        workerId,
        jobId: job.id,
        status: job.status,
      });
    },
    onJobHistoryPersisted: (job) => {
      process.send?.({
        type: "junius-job-history-persisted",
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
    controlPort: worker.controlPort,
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

process.once("disconnect", () => {
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
