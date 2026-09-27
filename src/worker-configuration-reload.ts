import type { ManagedWorker } from "./worker-process.js";
import { WORKER_AUTH_HEADER } from "./worker-auth.js";

const DEFAULT_CONFIGURATION_RELOAD_TIMEOUT_MS = 5_000;

export async function reloadWorkerConfiguration(
  worker: ManagedWorker,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    DEFAULT_CONFIGURATION_RELOAD_TIMEOUT_MS,
  );

  try {
    const response = await fetch(
      `http://127.0.0.1:${worker.adminPort}/__junius/config-reload`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          [WORKER_AUTH_HEADER]: worker.internalToken,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `configuration_reload_http_error: ${response.status}`,
      );
    }

    const body = await response.json() as {
      ok?: unknown;
      workerId?: unknown;
    };
    if (body.ok !== true || body.workerId !== worker.id) {
      throw new Error(
        "configuration_reload_invalid_response",
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
