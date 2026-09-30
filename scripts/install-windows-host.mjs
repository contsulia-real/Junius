import { spawn } from "node:child_process";
import {
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  windowsRunValue,
  windowsStartupPowerShell,
} from "./install-paths.mjs";
import {
  assertProcess,
} from "./install-process.mjs";

export async function writeWindowsStartup(
  paths,
  nodeExecutable,
) {
  const systemRoot =
    process.env.SystemRoot ??
    process.env.SYSTEMROOT ??
    "C:\\Windows";
  const powershell =
    join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  const reg =
    join(
      systemRoot,
      "System32",
      "reg.exe",
    );
  const launcherPath =
    join(
      paths.appRoot,
      "scripts",
      "host-launcher.mjs",
    );

  const script =
    windowsStartupPowerShell(
      nodeExecutable,
      launcherPath,
      paths.appRoot,
    );

  await mkdir(
    paths.root,
    { recursive: true },
  );
  await writeFile(
    paths.startupScript,
    script,
    "utf8",
  );
  await rm(
    paths.legacyStartupScript,
    { force: true },
  );

  await assertProcess(
    "Windows startup registration",
    reg,
    [
      "ADD",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      "Junius",
      "/t",
      "REG_SZ",
      "/d",
      windowsRunValue(
        powershell,
        paths.startupScript,
      ),
      "/f",
    ],
  );

  return {
    powershell,
    launcherPath,
  };
}

export async function readHostHealth(
  port = 8787,
) {
  try {
    const response =
      await fetch(
        `http://127.0.0.1:${port}/__junius/host-health`,
        {
          signal:
            AbortSignal.timeout(
              750,
            ),
        },
      );
    if (!response.ok) {
      return undefined;
    }

    const body =
      await response.json();

    if (
      body?.ok !== true ||
      typeof body
        .activeWorkerId !==
        "string" ||
      !Number.isSafeInteger(
        body.pid,
      ) ||
      body.pid <= 0
    ) {
      return undefined;
    }

    return {
      pid: body.pid,
      activeWorkerId:
        body.activeWorkerId,
      releaseId:
        typeof body.releaseId ===
        "string"
          ? body.releaseId
          : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function hostHealthy(
  port = 8787,
) {
  return (
    await readHostHealth(
      port,
    )
  ) !== undefined;
}

async function stopWindowsProcessTree(
  pid,
) {
  const systemRoot =
    process.env.SystemRoot ??
    process.env.SYSTEMROOT ??
    "C:\\Windows";
  const taskkill =
    join(
      systemRoot,
      "System32",
      "taskkill.exe",
    );

  await assertProcess(
    "Junius Host restart",
    taskkill,
    [
      "/PID",
      String(pid),
      "/T",
      "/F",
    ],
  );
}

export async function stopInstalledJunius(
  options = {},
) {
  const port =
    options.port ?? 8787;
  const timeoutMs =
    options.timeoutMs ??
    15_000;
  const stopProcessTree =
    options.stopProcessTree ??
    stopWindowsProcessTree;

  const health =
    await readHostHealth(
      port,
    );

  if (health === undefined) {
    return {
      wasRunning: false,
    };
  }

  await stopProcessTree(
    health.pid,
  );

  const deadline =
    Date.now() + timeoutMs;

  while (
    Date.now() <
    deadline
  ) {
    if (
      await readHostHealth(
        port,
      ) === undefined
    ) {
      return {
        wasRunning: true,
        pid: health.pid,
      };
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
    "Existing Junius Host did not stop before restart.",
  );
}

export async function startInstalledJunius(
  startup,
  timeoutMs =
    120_000,
) {
  if (
    await hostHealthy()
  ) {
    return {
      alreadyRunning: true,
    };
  }

  const child = spawn(
    startup.powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      startup.startupScript,
    ],
    {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  child.unref();

  const deadline =
    Date.now() + timeoutMs;

  while (
    Date.now() <
    deadline
  ) {
    if (
      await hostHealthy()
    ) {
      return {
        alreadyRunning: false,
      };
    }

    await new Promise(
      (resolvePromise) =>
        setTimeout(
          resolvePromise,
          250,
        ),
    );
  }

  throw new Error(
    "Junius did not become healthy after installation.",
  );
}
