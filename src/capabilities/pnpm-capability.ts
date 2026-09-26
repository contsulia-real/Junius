import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { MxcProcessCapability } from "./mxc-process-capability.js";

export interface PnpmLauncher {
  readonly executable: string;
  readonly fixedArgs: readonly string[];
  readonly readonlyPaths: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
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

export function resolvePnpmLauncher(
  environment: NodeJS.ProcessEnv = process.env,
  nodeExecutable = process.execPath,
): PnpmLauncher | undefined {
  const pnpmHome = environment.PNPM_HOME;

  if (pnpmHome) {
    const standalone = join(pnpmHome, "pnpm.exe");

    if (existsSync(standalone)) {
      return {
        executable: standalone,
        fixedArgs: [],
        readonlyPaths: [pnpmHome],
        environment: {
          PATH: pnpmHome,
        },
      };
    }
  }

  const npmExecPath = environment.npm_execpath;
  if (!npmExecPath || !/pnpm/iu.test(basename(npmExecPath))) {
    return undefined;
  }

  const extension = extname(npmExecPath).toLowerCase();
  if (![".js", ".cjs", ".mjs"].includes(extension)) {
    return undefined;
  }

  const nodeExecPath =
    environment.npm_node_execpath && existsSync(environment.npm_node_execpath)
      ? environment.npm_node_execpath
      : nodeExecutable;

  const cliDirectory = dirname(npmExecPath);
  const cliRoot =
    basename(cliDirectory).toLowerCase() === "bin"
      ? dirname(cliDirectory)
      : cliDirectory;

  return {
    executable: nodeExecPath,
    fixedArgs: [npmExecPath],
    readonlyPaths: [cliRoot],
    environment: {
      PATH: dirname(nodeExecPath),
    },
  };
}

export function createPnpmCapability():
  | MxcProcessCapability
  | undefined {
  const launcher = resolvePnpmLauncher();
  if (!launcher) {
    return undefined;
  }

  return new MxcProcessCapability({
    key: "pnpm",
    description:
      "pnpm package-script runner. Allows --version and pnpm run <script>; install/exec/dlx/add are not exposed.",
    executable: launcher.executable,
    fixedArgs: launcher.fixedArgs,
    readonlyPaths: launcher.readonlyPaths,
    argumentPolicy: isAllowedPnpmArgs,
    timeoutMs: 120_000,
    maxOutputBytes: 512 * 1024,
    environment: launcher.environment,
  });
}
