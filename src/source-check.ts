import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { terminateProcessTree } from "./process-termination.js";
import { withoutEnvironmentVariables } from "./execution-environment.js";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

const MAX_OUTPUT_CHARS = 512 * 1024;

interface PnpmLauncher {
  readonly executable: string;
  readonly fixedArgs: readonly string[];
}

export interface SourceCheckResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= MAX_OUTPUT_CHARS
    ? next
    : next.slice(next.length - MAX_OUTPUT_CHARS);
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
    return (
      bytesRead === 2 &&
      header[0] === 0x4d &&
      header[1] === 0x5a
    );
  } catch {
    return false;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function launcherFromCandidate(
  candidate: string,
  nodeExecutable: string | undefined,
): PnpmLauncher | undefined {
  if (!isFile(candidate)) return undefined;

  const extension = extname(candidate).toLowerCase();
  if (extension === ".exe" || isPortableExecutable(candidate)) {
    return {
      executable: candidate,
      fixedArgs: [],
    };
  }

  if ([".js", ".cjs", ".mjs"].includes(extension)) {
    return nodeExecutable === undefined
      ? undefined
      : {
          executable: nodeExecutable,
          fixedArgs: [candidate],
        };
  }

  return undefined;
}

function resolvePathNode(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const pathValue =
    environment.PATH ??
    environment.Path ??
    environment.path ??
    "";

  for (const rawEntry of pathValue.split(delimiter)) {
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

function resolveHostPnpm(
  environment: NodeJS.ProcessEnv,
): PnpmLauncher | undefined {
  const candidates: string[] = [];
  const nodeExecutable = resolvePathNode(environment);
  const pathValue =
    environment.PATH ??
    environment.Path ??
    environment.path ??
    "";

  for (const rawEntry of pathValue.split(delimiter)) {
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

  for (const candidate of candidates) {
    const launcher = launcherFromCandidate(
      candidate,
      nodeExecutable,
    );
    if (launcher !== undefined) return launcher;

    const shimTarget = targetFromWindowsCmdShim(candidate);
    if (shimTarget !== undefined) {
      const resolved = launcherFromCandidate(
        shimTarget,
        nodeExecutable,
      );
      if (resolved !== undefined) return resolved;
    }
  }

  return undefined;
}

export async function runSourceCheck(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  timeoutMs = 300_000,
): Promise<SourceCheckResult> {
  const launcher = resolveHostPnpm(environment);

  if (launcher === undefined) {
    throw new Error("pnpm_not_available_for_source_check");
  }

  const startedAt = performance.now();
  const childEnvironment = withoutEnvironmentVariables(
    environment,
    {
      names: [
        "NODE_OPTIONS",
        "NODE_PATH",
        "JUNIUS_INSTANCE_ROLE",
        "JUNIUS_MCP_PORT",
      ],
    },
  );

  return new Promise<SourceCheckResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let terminationPromise:
      Promise<void> |
      undefined;

    const child = spawn(
      launcher.executable,
      [...launcher.fixedArgs, "run", "check"],
      {
        cwd,
        env: childEnvironment,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, chunk);
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once(
      "close",
      async (
        exitCode,
        signal,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (
          terminationPromise !==
          undefined
        ) {
          await terminationPromise;
        }

        resolve({
          ok:
            !timedOut &&
            exitCode === 0,
          exitCode,
          signal,
          stdout,
          stderr,
          durationMs:
            Math.round(
              performance.now() -
                startedAt,
            ),
        });
      },
    );

    const timer = setTimeout(() => {
      timedOut = true;
      terminationPromise =
        terminateProcessTree(
          child,
          childEnvironment,
        ).catch((error) => {
          stderr =
            appendBounded(
              stderr,
              "\nprocess_tree_termination_failed: " +
                String(error),
            );
        });
    }, timeoutMs);
  });
}
