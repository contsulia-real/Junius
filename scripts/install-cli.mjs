import {
  mkdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  windowsCliCmd,
  windowsUserPathPowerShell,
} from "./install-paths.mjs";
import {
  assertProcess,
} from "./install-process.mjs";

export async function installWindowsCli(
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
  const cliPath =
    join(
      paths.appRoot,
      "bin",
      "junius.mjs",
    );

  await mkdir(
    paths.binRoot,
    { recursive: true },
  );
  await writeFile(
    paths.cliShim,
    windowsCliCmd(
      nodeExecutable,
      cliPath,
    ),
    "utf8",
  );

  await assertProcess(
    "Junius user PATH registration",
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      windowsUserPathPowerShell(
        paths.binRoot,
      ),
    ],
  );

  return {
    binRoot: paths.binRoot,
    cliShim: paths.cliShim,
  };
}
