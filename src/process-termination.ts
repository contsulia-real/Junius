import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { join } from "node:path";

const DEFAULT_GRACE_MS = 2_000;
const WINDOWS_KILLER_TIMEOUT_MS = 5_000;

function childExited(child: ChildProcess): boolean {
  return (
    child.exitCode !== null ||
    child.signalCode !== null
  );
}

async function waitForDirectChild(
  child: ChildProcess,
  graceMs: number,
): Promise<void> {
  if (childExited(child)) {
    return;
  }

  child.kill("SIGTERM");

  await new Promise<void>((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      if (!childExited(child)) {
        child.kill("SIGKILL");
      }
      finish();
    }, graceMs);

    child.once("close", finish);
  });
}

async function terminateWindowsProcessTree(
  child: ChildProcess,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (childExited(child)) {
    return;
  }

  const pid = child.pid;
  if (pid === undefined) {
    child.kill();
    return;
  }

  const systemRoot =
    environment.SystemRoot ??
    environment.SYSTEMROOT ??
    process.env.SystemRoot ??
    process.env.SYSTEMROOT ??
    "C:\\Windows";
  const taskkill = join(
    systemRoot,
    "System32",
    "taskkill.exe",
  );

  await new Promise<void>((resolve) => {
    let settled = false;
    let killer: ChildProcess | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const fallback = () => {
      if (!childExited(child)) {
        child.kill();
      }
      finish();
    };

    const timer = setTimeout(() => {
      if (
        killer !== undefined &&
        !childExited(killer)
      ) {
        killer.kill();
      }
      fallback();
    }, WINDOWS_KILLER_TIMEOUT_MS);

    try {
      killer = spawn(
        taskkill,
        ["/PID", String(pid), "/T", "/F"],
        {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
          env: environment,
        },
      );
    } catch {
      fallback();
      return;
    }

    killer.once("error", fallback);
    killer.once("close", (exitCode) => {
      if (
        exitCode === 0 ||
        childExited(child)
      ) {
        finish();
        return;
      }

      fallback();
    });
  });
}

export async function terminateProcessTree(
  child: ChildProcess,
  environment: NodeJS.ProcessEnv = process.env,
  graceMs = DEFAULT_GRACE_MS,
): Promise<void> {
  if (childExited(child)) {
    return;
  }

  if (process.platform === "win32") {
    await terminateWindowsProcessTree(
      child,
      environment,
    );
    return;
  }

  await waitForDirectChild(child, graceMs);
}
