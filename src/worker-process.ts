import {
  fork,
  type ChildProcess,
} from "node:child_process";
import { randomUUID } from "node:crypto";

const MAX_LOG_CHARS = 128 * 1024;

interface WorkerReadyMessage {
  readonly type: "junius-worker-ready";
  readonly workerId: string;
  readonly pid: number;
  readonly mcpPort: number;
  readonly adminPort: number;
}

interface WorkerStartupErrorMessage {
  readonly type: "junius-worker-startup-error";
  readonly workerId: string;
  readonly message: string;
}

export interface ManagedWorker {
  readonly id: string;
  readonly child: ChildProcess;
  readonly pid: number;
  readonly mcpPort: number;
  readonly adminPort: number;
  readonly startedAt: string;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: () => boolean;
  close(): Promise<void>;
}

export interface SpawnWorkerOptions {
  readonly workerEntryPath: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly publicMcpOrigin: string;
  readonly publicAdminOrigin: string;
  readonly startupTimeoutMs?: number;
  readonly execArgv?: readonly string[];
}

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= MAX_LOG_CHARS
    ? next
    : next.slice(next.length - MAX_LOG_CHARS);
}

function isReadyMessage(value: unknown): value is WorkerReadyMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;

  return (
    record.type === "junius-worker-ready" &&
    typeof record.workerId === "string" &&
    typeof record.pid === "number" &&
    typeof record.mcpPort === "number" &&
    typeof record.adminPort === "number"
  );
}

function isStartupErrorMessage(
  value: unknown,
): value is WorkerStartupErrorMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;

  return (
    record.type === "junius-worker-startup-error" &&
    typeof record.workerId === "string" &&
    typeof record.message === "string"
  );
}

async function assertHealthy(
  workerId: string,
  adminPort: number,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);

  try {
    const response = await fetch(
      `http://127.0.0.1:${adminPort}/__junius/worker-health`,
      { signal: controller.signal },
    );

    if (!response.ok) {
      throw new Error(
        `worker_health_http_error: ${response.status}`,
      );
    }

    const body = await response.json() as {
      ok?: unknown;
      workerId?: unknown;
    };

    if (body.ok !== true || body.workerId !== workerId) {
      throw new Error("worker_health_invalid_response");
    }
  } finally {
    clearTimeout(timer);
  }
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;

    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };

    const onExit = () => finish(true);
    child.once("exit", onExit);

    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

export async function spawnManagedWorker(
  options: SpawnWorkerOptions,
): Promise<ManagedWorker> {
  const id = randomUUID();
  let stdout = "";
  let stderr = "";
  let exited = false;

  const child = fork(options.workerEntryPath, [], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.environment,
      JUNIUS_WORKER_ID: id,
      JUNIUS_PUBLIC_MCP_ORIGIN: options.publicMcpOrigin,
      JUNIUS_PUBLIC_ADMIN_ORIGIN: options.publicAdminOrigin,
    },
    execArgv: [
      ...(options.execArgv ?? ["--import", "tsx"]),
    ],
    silent: true,
  });

  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = appendBounded(stderr, chunk);
  });
  child.once("exit", () => {
    exited = true;
  });

  const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;

  let ready: WorkerReadyMessage;
  try {
    ready = await new Promise<WorkerReadyMessage>((resolve, reject) => {
      let settled = false;

      const finish = (
        error: Error | undefined,
        message?: WorkerReadyMessage,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);

        if (error !== undefined) {
          reject(error);
        } else {
          resolve(message!);
        }
      };

      const onMessage = (message: unknown) => {
        if (isReadyMessage(message)) {
          finish(undefined, message);
          return;
        }

        if (isStartupErrorMessage(message)) {
          finish(
            new Error(
              `worker_startup_failed: ${message.message}`,
            ),
          );
        }
      };

      const onExit = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        finish(
          new Error(
            `worker_exited_before_ready: code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
          ),
        );
      };

      child.on("message", onMessage);
      child.once("exit", onExit);

      const timer = setTimeout(() => {
        finish(
          new Error(
            `worker_startup_timeout: ${startupTimeoutMs}ms`,
          ),
        );
      }, startupTimeoutMs);
    });

    if (ready.workerId !== id) {
      throw new Error("worker_ready_id_mismatch");
    }

    await assertHealthy(id, ready.adminPort);
  } catch (error) {
    child.kill();
    await waitForExit(child, 2_000);
    throw error;
  }

  const startedAt = new Date().toISOString();

  return {
    id,
    child,
    pid: ready.pid,
    mcpPort: ready.mcpPort,
    adminPort: ready.adminPort,
    startedAt,
    stdout: () => stdout,
    stderr: () => stderr,
    exited: () => exited,
    async close() {
      if (exited) return;

      if (child.connected) {
        child.send({ type: "junius-worker-shutdown" });
      } else {
        child.kill();
      }

      if (!(await waitForExit(child, 5_000))) {
        child.kill("SIGTERM");
        if (!(await waitForExit(child, 2_000))) {
          child.kill("SIGKILL");
          await waitForExit(child, 1_000);
        }
      }
    },
  };
}
