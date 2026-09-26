import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  createConfigFromPolicy,
  spawnSandboxFromConfig,
} from "@microsoft/mxc-sdk";

function quoteWindowsArgument(value: string): string {
  if (value.length === 0) {
    return '""';
  }

  if (!/[\\s"]/u.test(value)) {
    return value;
  }

  let result = '"';
  let backslashes = 0;

  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }

    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1);
      result += '"';
      backslashes = 0;
      continue;
    }

    result += "\\".repeat(backslashes);
    result += character;
    backslashes = 0;
  }

  result += "\\".repeat(backslashes * 2);
  result += '"';
  return result;
}

async function waitForChild(child: ChildProcess): Promise<{
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const [exitCode, signal] = (await once(child, "close")) as [
    number | null,
    NodeJS.Signals | null,
  ];

  return { exitCode, signal, stdout, stderr };
}

function requireHostEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error("Required host environment variable is missing: " + name);
  }
  return value;
}

if (process.platform !== "win32") {
  throw new Error("The MXC environment probe must run on Windows.");
}

const probeRootRaw = await mkdtemp(join(tmpdir(), "junius-mxc-env-"));
const probeRoot = await realpath(probeRootRaw);
const workspaceRoot = join(probeRoot, "workspace");

const sentinelName = "JUNIUS_MXC_HOST_SECRET_SENTINEL";
const explicitMarkerName = "JUNIUS_MXC_EXPLICIT_MARKER";
const sentinelValue = "must-not-leak";
const explicitMarkerValue = "explicit-ok";

const previousSentinel = process.env[sentinelName];
process.env[sentinelName] = sentinelValue;

try {
  await mkdir(workspaceRoot, { recursive: true });

  const systemRoot =
    process.env.SYSTEMROOT ??
    process.env.SystemRoot ??
    requireHostEnv("SystemRoot");
  const localAppData =
    process.env.LOCALAPPDATA ??
    process.env.LocalAppData ??
    requireHostEnv("LOCALAPPDATA");

  const sandboxSource = [
    'const wanted = ["SYSTEMROOT","LOCALAPPDATA","TEMP","TMP","JUNIUS_MXC_EXPLICIT_MARKER","JUNIUS_MXC_HOST_SECRET_SENTINEL"];',
    'const selected = Object.fromEntries(wanted.map((name) => [name, process.env[name] ?? null]));',
    'process.stdout.write(JSON.stringify({ selected, keys: Object.keys(process.env).sort() }) + "\\n");',
  ].join("\n");

  const config = createConfigFromPolicy(
    {
      version: "0.8.0-alpha",
      filesystem: {
        readwritePaths: [workspaceRoot],
        readonlyPaths: [],
      },
      network: {
        egress: { default: "deny" },
        ingress: { default: "deny", hostLoopback: "deny" },
      },
      ui: {
        allowWindows: true,
        clipboard: "none",
        allowInputInjection: false,
      },
      timeoutMs: 10_000,
    },
    "process",
  );

  config.process!.commandLine = [
    process.execPath,
    "-e",
    sandboxSource,
  ]
    .map(quoteWindowsArgument)
    .join(" ");
  config.process!.cwd = workspaceRoot;
  config.process!.env = [
    "SYSTEMROOT=" + systemRoot,
    "LOCALAPPDATA=" + localAppData,
    "TEMP=" + workspaceRoot,
    "TMP=" + workspaceRoot,
    explicitMarkerName + "=" + explicitMarkerValue,
  ];

  const child = spawnSandboxFromConfig(
    config,
    {
      usePty: false,
      experimental: true,
      debug: true,
    },
    workspaceRoot,
  );

  const execution = await waitForChild(child);

  let childResult:
    | {
        readonly selected: Record<string, string | null>;
        readonly keys: string[];
      }
    | undefined;

  if (execution.stdout) {
    const lines = execution.stdout.trim().split(/\r?\n/u);
    const candidate = [...lines]
      .reverse()
      .find((line) => line.startsWith('{"selected":'));

    if (candidate) {
      childResult = JSON.parse(candidate) as {
        readonly selected: Record<string, string | null>;
        readonly keys: string[];
      };
    }
  }

  const explicitMarkerPresent =
    childResult?.selected[explicitMarkerName] === explicitMarkerValue;
  const hostSentinelAbsent =
    childResult?.selected[sentinelName] === null &&
    !childResult?.keys.some(
      (key) => key.toUpperCase() === sentinelName,
    );

  console.log(
    JSON.stringify(
      {
        probeExecuted: execution.exitCode === 0 && childResult !== undefined,
        sdk: "@microsoft/mxc-sdk@0.8.0",
        requestedContainment: "process",
        workspaceRoot,
        suppliedEnvNames: config.process!.env.map(
          (entry) => entry.slice(0, entry.indexOf("=")),
        ),
        executor: execution,
        childResult,
        conclusions: {
          explicitEnvironmentLaunchWorks:
            execution.exitCode === 0 && childResult !== undefined,
          explicitMarkerPresent,
          hostSentinelAbsent,
        },
      },
      null,
      2,
    ),
  );

  if (
    execution.exitCode !== 0 ||
    childResult === undefined ||
    !explicitMarkerPresent ||
    !hostSentinelAbsent
  ) {
    process.exitCode = 1;
  }
} finally {
  if (previousSentinel === undefined) {
    delete process.env[sentinelName];
  } else {
    process.env[sentinelName] = previousSentinel;
  }

  await rm(probeRoot, { recursive: true, force: true });
}
