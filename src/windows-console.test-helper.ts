import { spawn } from "node:child_process";
import { once } from "node:events";

export async function windowsProcessOwnsConsole(
  pid: number,
): Promise<boolean> {
  if (process.platform !== "win32") {
    throw new Error("windows_console_probe_requires_windows");
  }

  const source = [
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class JuniusConsoleProbe {",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId);",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool FreeConsole();",
    "}",
  ].join("\n");

  const script = [
    "Add-Type @'",
    source,
    "'@",
    "[JuniusConsoleProbe]::FreeConsole() | Out-Null",
    `if ([JuniusConsoleProbe]::AttachConsole(${pid})) { exit 10 } else { exit 11 }`,
  ].join("\n");

  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      script,
    ],
    {
      windowsHide: true,
      stdio: "ignore",
    },
  );

  const [exitCode] =
    await once(
      child,
      "exit",
    );

  if (exitCode === 10) {
    return true;
  }
  if (exitCode === 11) {
    return false;
  }

  throw new Error(
    `windows_console_probe_failed: exit=${String(exitCode)}`,
  );
}
