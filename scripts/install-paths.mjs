import { homedir } from "node:os";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

export function packageRootFromImportMeta(
  importMetaUrl,
) {
  return resolve(
    dirname(
      fileURLToPath(importMetaUrl),
    ),
    "..",
  );
}

export function windowsInstallPaths(
  environment = process.env,
) {
  const localAppData =
    environment.LOCALAPPDATA ??
    join(
      homedir(),
      "AppData",
      "Local",
    );
  const root = join(
    localAppData,
    "Junius",
  );

  return {
    root,
    appRoot: join(root, "app"),
    startupScript: join(
      root,
      "start-junius.vbs",
    ),
    venvRoot: join(
      root,
      "app",
      ".venv",
    ),
  };
}

export function vbsString(value) {
  return String(value)
    .replaceAll('"', '""');
}

export function windowsStartupVbs(
  nodeExecutable,
  launcherPath,
  appRoot,
) {
  const command =
    `"${nodeExecutable}" "${launcherPath}"`;

  return [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${vbsString(appRoot)}"`,
    `shell.Run "${vbsString(command)}", 0, False`,
    "",
  ].join("\r\n");
}

export function windowsRunValue(
  wscriptExecutable,
  startupScript,
) {
  return (
    `"${wscriptExecutable}" //B //Nologo "${startupScript}"`
  );
}
