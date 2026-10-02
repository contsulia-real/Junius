import { spawn } from "node:child_process";
import {
  HEALTH_TIMEOUT_MS,
  projectRoot,
} from "./host-bootstrap-paths.mjs";

let activeHost;

const developmentMode =
  process.env
    .JUNIUS_INSTANCE_ROLE ===
  "development";

function spawnHost(
  release,
) {
  const args =
    release.compiled === true
      ? [release.hostPath]
      : [
          "--import",
          "tsx",
          release.hostPath,
        ];

  return spawn(
    process.execPath,
    args,
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        JUNIUS_PROJECT_ROOT:
          projectRoot,
        JUNIUS_WORKER_ENTRY_PATH:
          release.workerPath,
        JUNIUS_RELEASE_ID:
          release.releaseId,
        JUNIUS_RELEASE_ROOT:
          release.releaseRoot,
      },
      stdio:
        developmentMode
          ? "inherit"
          : "ignore",
      windowsHide:
        !developmentMode,
    },
  );
}

async function waitForHostHealth(
  child,
  releaseId,
) {
  const port =
    Number(
      process.env
        .JUNIUS_MCP_PORT ??
        "8787",
    );
  const deadline =
    Date.now() +
    HEALTH_TIMEOUT_MS;
  let lastError;

  while (
    Date.now() <
    deadline
  ) {
    if (
      child.exitCode !==
        null ||
      child.signalCode !==
        null
    ) {
      throw new Error(
        `host_exited_before_health: code=${String(child.exitCode)} signal=${String(child.signalCode)}`,
      );
    }

    try {
      const response =
        await fetch(
          `http://127.0.0.1:${port}/__junius/host-health`,
        );

      if (response.ok) {
        const body =
          await response.json();

        if (
          body?.ok === true &&
          typeof body
            .activeWorkerId ===
            "string" &&
          body.releaseId ===
            releaseId
        ) {
          return;
        }
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise(
      (resolvePromise) =>
        setTimeout(
          resolvePromise,
          100,
        ),
    );
  }

  throw new Error(
    "host_health_timeout: " +
      String(
        lastError ?? "",
      ),
  );
}

export async function stopChild(
  child,
) {
  if (
    child.exitCode !==
      null ||
    child.signalCode !==
      null
  ) {
    return;
  }

  child.kill("SIGTERM");

  await new Promise(
    (resolvePromise) => {
      const timer =
        setTimeout(
          resolvePromise,
          3_000,
        );

      child.once(
        "exit",
        () => {
          clearTimeout(
            timer,
          );
          resolvePromise();
        },
      );
    },
  );

  if (
    child.exitCode ===
      null &&
    child.signalCode ===
      null
  ) {
    child.kill(
      "SIGKILL",
    );
  }
}

async function waitForChild(
  child,
) {
  if (
    child.exitCode !==
      null ||
    child.signalCode !==
      null
  ) {
    process.exitCode =
      child.exitCode ?? 0;
    return;
  }

  const result =
    await new Promise(
      (resolvePromise) => {
        child.once(
          "exit",
          (
            code,
            signal,
          ) => {
            resolvePromise({
              code,
              signal,
            });
          },
        );
      },
    );

  process.exitCode =
    result.code ?? 0;
}

export async function startRelease(
  release,
) {
  console.error(
    `[bootstrap] starting release ${release.releaseId}`,
  );

  const child =
    spawnHost(
      release,
    );
  activeHost = child;

  await waitForHostHealth(
    child,
    release.releaseId,
  );

  return child;
}

export async function finishStartedHost(
  child,
) {
  if (
    process.env
      .JUNIUS_BOOTSTRAP_TEST_EXIT_AFTER_HEALTH ===
    "1"
  ) {
    await stopChild(
      child,
    );
    return;
  }

  await waitForChild(
    child,
  );
}

export function forwardSignal(
  signal,
) {
  if (
    activeHost !==
      undefined &&
    activeHost.exitCode ===
      null &&
    activeHost.signalCode ===
      null
  ) {
    try {
      activeHost.kill(
        signal,
      );
    } catch {
      activeHost.kill();
    }
  }
}
