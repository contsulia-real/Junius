import {
  closeSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import {
  basename,
  delimiter,
  extname,
  join,
} from "node:path";
import { ProcessCapability } from "./process-capability.js";

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
  nodeExecutable: string,
): PnpmLauncher | undefined {
  if (!isFile(candidate)) {
    return undefined;
  }

  const extension = extname(candidate).toLowerCase();

  if (extension === ".exe" || isPortableExecutable(candidate)) {
    return nativeLauncher(candidate);
  }

  if ([".js", ".cjs", ".mjs"].includes(extension)) {
    return javascriptLauncher(candidate, nodeExecutable);
  }

  return undefined;
}

function candidatePaths(
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  const candidates: string[] = [];

  const direct = environment.npm_execpath;
  if (direct && /pnpm/iu.test(basename(direct))) {
    candidates.push(direct);
  }

  const pnpmHome = environment.PNPM_HOME;
  if (pnpmHome) {
    candidates.push(
      join(pnpmHome, "pnpm.exe"),
      join(pnpmHome, "pnpm"),
      join(pnpmHome, "pnpm.cjs"),
      join(pnpmHome, "pnpm.js"),
      join(pnpmHome, "pnpm.mjs"),
      join(pnpmHome, "bin", "pnpm.exe"),
      join(pnpmHome, "bin", "pnpm"),
    );
  }

  for (const rawEntry of (environment.PATH ?? "").split(delimiter)) {
    const entry = rawEntry.trim();
    if (!entry) {
      continue;
    }

    candidates.push(
      join(entry, "pnpm.exe"),
      join(entry, "pnpm"),
      join(entry, "pnpm.cjs"),
      join(entry, "pnpm.js"),
      join(entry, "pnpm.mjs"),

      // npm global installation layouts
      join(entry, "node_modules", "pnpm", "pnpm.exe"),
      join(entry, "node_modules", "pnpm", "pnpm"),
      join(entry, "node_modules", "pnpm", "bin", "pnpm.cjs"),
      join(entry, "node_modules", "pnpm", "bin", "pnpm.js"),
      join(entry, "node_modules", "pnpm", "bin", "pnpm.mjs"),

      // Corepack installation layout
      join(entry, "node_modules", "corepack", "dist", "pnpm.js"),
      join(entry, "node_modules", "corepack", "dist", "pnpm.cjs"),
    );
  }

  return [...new Set(candidates)];
}

export function resolvePnpmLauncher(
  environment: NodeJS.ProcessEnv = process.env,
  nodeExecutable = process.execPath,
): PnpmLauncher | undefined {
  for (const candidate of candidatePaths(environment)) {
    const launcher = launcherFromCandidate(candidate, nodeExecutable);
    if (launcher) {
      return launcher;
    }
  }

  return undefined;
}

export function createPnpmCapability(
  launcher: PnpmLauncher | undefined = resolvePnpmLauncher(),
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
    timeoutMs: 120_000,
    maxOutputBytes: 512 * 1024,
  });
}
