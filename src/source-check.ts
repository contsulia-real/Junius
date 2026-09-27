import {
  closeSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import {
  basename,
  delimiter,
  extname,
  join,
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
    return {
      executable: process.execPath,
      fixedArgs: [candidate],
    };
  }

  return undefined;
}

function resolveHostPnpm(
  environment: NodeJS.ProcessEnv,
): PnpmLauncher | undefined {
  const candidates: string[] = [];
  const npmExecPath = environment.npm_execpath;

  if (
    npmExecPath &&
    /pnpm/iu.test(basename(npmExecPath))
  ) {
    candidates.push(npmExecPath);
  }

  if (environment.PNPM_HOME) {
    candidates.push(
      join(environment.PNPM_HOME, "pnpm.exe"),
      join(environment.PNPM_HOME, "pnpm.cjs"),
      join(environment.PNPM_HOME, "pnpm.js"),
      join(environment.PNPM_HOME, "pnpm.mjs"),
    );
  }

  for (const rawEntry of (environment.PATH ?? "").split(delimiter)) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    candidates.push(
      join(entry, "pnpm.exe"),
      join(entry, "pnpm.cjs"),
      join(entry, "pnpm.js"),
      join(entry, "pnpm.mjs"),
      join(entry, "node_modules", "pnpm", "bin", "pnpm.cjs"),
      join(entry, "node_modules", "corepack", "dist", "pnpm.js"),
    );
  }

  for (const candidate of [...new Set(candidates)]) {
    const launcher = launcherFromCandidate(candidate);
    if (launcher !== undefined) return launcher;
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

  return new Promise<SourceCheckResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(
      launcher.executable,
      [...launcher.fixedArgs, "run", "check"],
      {
        cwd,
        env: environment,
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

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      resolve({
        ok: !timedOut && exitCode === 0,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
  });
}
