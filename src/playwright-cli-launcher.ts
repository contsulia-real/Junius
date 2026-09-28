import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { resolveNodeExecutable } from "./node-executable.js";

export interface PlaywrightCliLauncher {
  readonly executable: string;
  readonly fixedArgs: readonly string[];
  readonly entryPath?: string;
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

function launcherFromCandidate(
  candidate: string,
  nodeExecutable: string | undefined,
): PlaywrightCliLauncher | undefined {
  if (!isFile(candidate)) {
    return undefined;
  }

  const extension = extname(candidate).toLowerCase();

  if (extension === ".exe" || isPortableExecutable(candidate)) {
    return {
      executable: candidate,
      fixedArgs: [],
    };
  }

  if ([".js", ".cjs", ".mjs"].includes(extension)) {
    if (nodeExecutable === undefined) return undefined;

    return {
      executable: nodeExecutable,
      fixedArgs: [candidate],
      entryPath: candidate,
    };
  }

  return undefined;
}

function targetFromWindowsCmdShim(
  shimPath: string,
): string | undefined {
  if (process.platform !== "win32" || extname(shimPath).toLowerCase() !== ".cmd") {
    return undefined;
  }

  try {
    const text = readFileSync(shimPath, "utf8");
    const match = text.match(
      /["']?([^"'\r\n]*playwright-cli\.js)["']?/iu,
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

export function resolveBrowserStatePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.JUNIUS_BROWSER_STATE_PATH) {
    return environment.JUNIUS_BROWSER_STATE_PATH;
  }

  if (process.platform === "win32") {
    const localAppData =
      environment.LOCALAPPDATA ??
      join(homedir(), "AppData", "Local");

    return join(localAppData, "Junius", "browser");
  }

  const stateRoot =
    environment.XDG_STATE_HOME ??
    join(homedir(), ".local", "state");

  return join(stateRoot, "Junius", "browser");
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

function candidatePaths(
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  const candidates: string[] = [];

  for (const rawEntry of environmentPath(environment).split(delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/u, "$1");
    if (!entry) continue;

    candidates.push(
      join(entry, "playwright-cli.exe"),
      join(entry, "playwright-cli"),
      join(entry, "playwright-cli.js"),
      join(entry, "playwright-cli.cjs"),
      join(entry, "playwright-cli.mjs"),
      join(entry, "playwright-cli.cmd"),
    );
  }

  return candidates;
}

export function resolvePlaywrightCliLauncher(
  environment: NodeJS.ProcessEnv = process.env,
  nodeExecutable = resolveNodeExecutable(environment),
): PlaywrightCliLauncher | undefined {
  for (const candidate of candidatePaths(environment)) {
    const direct = launcherFromCandidate(candidate, nodeExecutable);
    if (direct) {
      return direct;
    }

    const shimTarget = targetFromWindowsCmdShim(candidate);
    if (shimTarget) {
      const resolved = launcherFromCandidate(shimTarget, nodeExecutable);
      if (resolved) {
        return resolved;
      }
    }
  }

  return undefined;
}

export function supportsPersistentBroker(
  entryPath: string | undefined,
): entryPath is string {
  if (entryPath === undefined) return false;

  try {
    const source = readFileSync(entryPath, "utf8");
    return /\{\s*program\s*\}\s*=\s*require\(["'][^"']+["']\)/u.test(
      source,
    );
  } catch {
    return false;
  }
}


