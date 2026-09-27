import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { ProcessCapability } from "./process-capability.js";
import { resolveNodeExecutable } from "./node-capability.js";

export interface PnpmLauncher {
  readonly executable: string;
  readonly fixedArgs: readonly string[];
}

const SCRIPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export function isAllowedPnpmArgs(args: readonly string[]): boolean {
  if (args.length === 1 && args[0] === "--version") {
    return true;
  }

  if (
    args.length === 2 &&
    args[0] === "run" &&
    SCRIPT_NAME_PATTERN.test(args[1] ?? "")
  ) {
    return true;
  }

  if (
    args.length >= 4 &&
    args[0] === "run" &&
    SCRIPT_NAME_PATTERN.test(args[1] ?? "") &&
    args[2] === "--"
  ) {
    return true;
  }

  return false;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isPortableExecutable(path: string): boolean {
  let handle: number | undefined;

  try {
    handle = openSync(path, "r");
    const header = Buffer.allocUnsafe(2);
    const bytesRead = readSync(handle, header, 0, 2, 0);
    return bytesRead === 2 && header[0] === 0x4d && header[1] === 0x5a;
  } catch {
    return false;
  } finally {
    if (handle !== undefined) {
      closeSync(handle);
    }
  }
}

function javascriptLauncher(
  entry: string,
  nodeExecutable: string,
): PnpmLauncher {
  return {
    executable: nodeExecutable,
    fixedArgs: [entry],
  };
}

function nativeLauncher(path: string): PnpmLauncher {
  return {
    executable: path,
    fixedArgs: [],
  };
}

function launcherFromCandidate(
  candidate: string,
  nodeExecutable: string | undefined,
): PnpmLauncher | undefined {
  if (!isFile(candidate)) {
    return undefined;
  }

  const extension = extname(candidate).toLowerCase();

  if (extension === ".exe" || isPortableExecutable(candidate)) {
    return nativeLauncher(candidate);
  }

  if ([".js", ".cjs", ".mjs"].includes(extension)) {
    return nodeExecutable === undefined
      ? undefined
      : javascriptLauncher(candidate, nodeExecutable);
  }

  return undefined;
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

function targetFromWindowsCmdShim(
  shimPath: string,
): string | undefined {
  if (
    process.platform !== "win32" ||
    extname(shimPath).toLowerCase() !== ".cmd"
  ) {
    return undefined;
  }

  try {
    const text = readFileSync(shimPath, "utf8");
    const match = text.match(
      /["']?([^"'\r\n]*(?:pnpm\.exe|pnpm\.(?:cjs|mjs|js)))["']?/iu,
    );

    if (match?.[1] === undefined) {
      return undefined;
    }

    const expanded = match[1]
      .replaceAll("%dp0%", dirname(shimPath) + "\\")
      .replaceAll("%~dp0", dirname(shimPath) + "\\");

    return isAbsolute(expanded)
      ? resolve(expanded)
      : resolve(dirname(shimPath), expanded);
  } catch {
    return undefined;
  }
}

function candidatePaths(
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  const candidates: string[] = [];

  for (const rawEntry of environmentPath(environment).split(delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/u, "$1");
    if (!entry) continue;

    candidates.push(
      join(entry, "pnpm.exe"),
      join(entry, "pnpm"),
      join(entry, "pnpm.cmd"),
      join(entry, "pnpm.cjs"),
      join(entry, "pnpm.js"),
      join(entry, "pnpm.mjs"),
    );
  }

  return candidates;
}

export function resolvePnpmLauncher(
  environment: NodeJS.ProcessEnv = process.env,
  nodeExecutable = resolveNodeExecutable(environment),
): PnpmLauncher | undefined {
  for (const candidate of candidatePaths(environment)) {
    const launcher = launcherFromCandidate(candidate, nodeExecutable);
    if (launcher) {
      return launcher;
    }

    const shimTarget = targetFromWindowsCmdShim(candidate);
    if (shimTarget !== undefined) {
      const resolved = launcherFromCandidate(
        shimTarget,
        nodeExecutable,
      );
      if (resolved !== undefined) {
        return resolved;
      }
    }
  }

  return undefined;
}

export function createPnpmCapability(
  launcher: PnpmLauncher | undefined = resolvePnpmLauncher(),
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): ProcessCapability | undefined {
  if (!launcher) {
    return undefined;
  }

  return new ProcessCapability({
    key: "pnpm",
    description:
      "pnpm package-script runner. Allows --version and pnpm run <script>; install/exec/dlx/add are not exposed.",
    executable: launcher.executable,
    fixedArgs: launcher.fixedArgs,
    argumentPolicy: isAllowedPnpmArgs,
    inheritedEnvironment,
    inheritedEnvironmentDenyNames: [
      "NODE_OPTIONS",
      "NODE_PATH",
    ],
    timeoutMs: 120_000,
    maxOutputBytes: 512 * 1024,
  });
}
