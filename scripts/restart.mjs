import { join } from "node:path";
import {
  windowsInstallPaths,
} from "./install-paths.mjs";
import {
  readHostHealth,
  startInstalledJunius,
  stopInstalledJunius,
} from "./install-windows-host.mjs";
import {
  assertWindowsPlatform,
} from "./windows-only.mjs";

export async function restartJunius(
  options = {},
) {
  const platform =
    options.platform ??
    process.platform;
  assertWindowsPlatform(
    platform,
  );

  const environment =
    options.environment ??
    process.env;
  const paths =
    options.paths ??
    windowsInstallPaths(
      environment,
    );
  const port =
    options.port ??
    8787;
  const readHealth =
    options.readHostHealth ??
    readHostHealth;
  const stop =
    options.stopInstalledJunius ??
    stopInstalledJunius;
  const start =
    options.startInstalledJunius ??
    startInstalledJunius;
  const nodeExecutable =
    options.nodeExecutable ??
    process.execPath;

  const before =
    await readHealth(port);

  const stopped =
    await stop({
      port,
    });

  await start(
    {
      nodeExecutable,
      launcherPath:
        join(
          paths.appRoot,
          "scripts",
          "host-launcher.mjs",
        ),
      appRoot:
        paths.appRoot,
    },
    {
      port,
    },
  );

  const after =
    await readHealth(port);

  if (
    after === undefined
  ) {
    throw new Error(
      "Junius restart completed without a healthy Host.",
    );
  }

  return {
    restarted:
      stopped.wasRunning,
    previousPid:
      before?.pid,
    pid:
      after.pid,
    activeWorkerId:
      after.activeWorkerId,
    releaseId:
      after.releaseId,
  };
}
