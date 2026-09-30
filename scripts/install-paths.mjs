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
    promptRoot: join(root, "prompts"),
    startupScript: join(
      root,
      "start-junius.ps1",
    ),
    legacyStartupScript: join(
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

function powershellLiteral(
  value,
) {
  return (
    "'" +
    String(value)
      .replaceAll(
        "'",
        "''",
      ) +
    "'"
  );
}

export function windowsStartupPowerShell(
  nodeExecutable,
  launcherPath,
  appRoot,
) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$startInfo = New-Object System.Diagnostics.ProcessStartInfo",
    `$startInfo.FileName = ${powershellLiteral(nodeExecutable)}`,
    `$startInfo.Arguments = ${powershellLiteral(`"${launcherPath}"`)}`,
    `$startInfo.WorkingDirectory = ${powershellLiteral(appRoot)}`,
    "$startInfo.UseShellExecute = $false",
    "$startInfo.CreateNoWindow = $true",
    "$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden",
    "[void][System.Diagnostics.Process]::Start($startInfo)",
    "",
  ].join("\r\n");
}

export function windowsRunValue(
  powershellExecutable,
  startupScript,
) {
  return (
    `"${powershellExecutable}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${startupScript}"`
  );
}
