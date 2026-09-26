import {
  realpath,
  stat,
} from "node:fs/promises";
import { delimiter, dirname, extname } from "node:path";

interface PathInfo {
  readonly value: string | null;
  readonly exists: boolean;
  readonly realpath?: string;
  readonly extension?: string;
  readonly directory?: string;
  readonly error?: string;
}

async function inspectPath(value: string | undefined): Promise<PathInfo> {
  if (!value) {
    return {
      value: null,
      exists: false,
    };
  }

  try {
    await stat(value);
    const resolved = await realpath(value);
    return {
      value,
      exists: true,
      realpath: resolved,
      extension: extname(resolved).toLowerCase(),
      directory: dirname(resolved),
    };
  } catch (error) {
    return {
      value,
      exists: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const npmExecPath = process.env.npm_execpath;
const npmNodeExecPath = process.env.npm_node_execpath;
const pnpmHome = process.env.PNPM_HOME;

const pathEntries = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((entry) => /pnpm|corepack/iu.test(entry));

const npmExec = await inspectPath(npmExecPath);
const npmNodeExec = await inspectPath(npmNodeExecPath);
const pnpmHomeInfo = await inspectPath(pnpmHome);

let inferredLaunchKind:
  | "native-executable"
  | "cmd-shim"
  | "javascript-entry"
  | "unknown";

switch (npmExec.extension) {
  case ".exe":
    inferredLaunchKind = "native-executable";
    break;
  case ".cmd":
  case ".bat":
    inferredLaunchKind = "cmd-shim";
    break;
  case ".js":
  case ".cjs":
  case ".mjs":
    inferredLaunchKind = "javascript-entry";
    break;
  default:
    inferredLaunchKind = "unknown";
    break;
}

console.log(
  JSON.stringify(
    {
      probeExecuted: true,
      platform: process.platform,
      node: {
        execPath: process.execPath,
        version: process.version,
      },
      pnpm: {
        userAgent: process.env.npm_config_user_agent ?? null,
        exec: npmExec,
        nodeExec: npmNodeExec,
        pnpmHome: pnpmHomeInfo,
        matchingPathEntries: pathEntries,
        inferredLaunchKind,
      },
    },
    null,
    2,
  ),
);
