import { statSync } from "node:fs";
import {
  delimiter,
  join,
} from "node:path";
import { ProcessCapability } from "./process-capability.js";

export interface NodeLauncher {
  readonly executable: string;
  readonly fixedArgs: readonly string[];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function environmentPath(
  environment: NodeJS.ProcessEnv,
): string {
  return (
    environment.PATH ??
    environment.Path ??
    environment.path ??
    ""
  );
}

export function resolveNodeExecutable(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const rawEntry of environmentPath(environment).split(delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/u, "$1");
    if (!entry) continue;

    const candidates =
      process.platform === "win32"
        ? [
            join(entry, "node.exe"),
            join(entry, "node"),
          ]
        : [join(entry, "node")];

    for (const candidate of candidates) {
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

export function createNodeCapability(
  launcher: NodeLauncher | undefined = (() => {
    const executable = resolveNodeExecutable();
    return executable === undefined
      ? undefined
      : { executable, fixedArgs: [] };
  })(),
): ProcessCapability | undefined {
  if (launcher === undefined) {
    return undefined;
  }

  return new ProcessCapability({
    key: "node",
    description:
      "Node.js executable resolved from PATH. Only --version and -p process.platform are permitted.",
    executable: launcher.executable,
    fixedArgs: launcher.fixedArgs,
    allowedArgVectors: [
      ["--version"],
      ["-p", "process.platform"],
    ],
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024,
  });
}
