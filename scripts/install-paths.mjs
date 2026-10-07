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
    binRoot: join(root, "bin"),
    cliShim: join(
      root,
      "bin",
      "junius.cmd",
    ),
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

export function windowsCliCmd(
  nodeExecutable,
  cliPath,
) {
  return [
    "@echo off",
    `"${nodeExecutable}" "${cliPath}" %*`,
    "",
  ].join("\r\n");
}

export function windowsUserPathPowerShell(
  binRoot,
) {
  const entry =
    powershellLiteral(binRoot);

  return [
    "$ErrorActionPreference = 'Stop'",
    `$entry = ${entry}`,
    "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$entries = if ([string]::IsNullOrWhiteSpace($current)) { @() } else { @($current.Split(';') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) }",
    "$exists = $false",
    "foreach ($item in $entries) {",
    "  if ([string]::Equals($item.Trim().TrimEnd([char]92), $entry.TrimEnd([char]92), [System.StringComparison]::OrdinalIgnoreCase)) {",
    "    $exists = $true",
    "    break",
    "  }",
    "}",
    "if (-not $exists) {",
    "  $next = if ([string]::IsNullOrWhiteSpace($current)) { $entry } else { $current.TrimEnd(';') + ';' + $entry }",
    "  [Environment]::SetEnvironmentVariable('Path', $next, 'User')",
    "}",
    "",
  ].join("\r\n");
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
