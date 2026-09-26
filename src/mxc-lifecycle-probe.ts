import { once } from "node:events";
import {
  access,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  createConfigFromPolicy,
  getAvailableToolsPolicy,
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

if (process.platform !== "win32") {
  throw new Error("The MXC lifecycle probe must run on Windows.");
}

const probeRootRaw = await mkdtemp(join(tmpdir(), "junius-mxc-lifecycle-"));
const probeRoot = await realpath(probeRootRaw);
const workspaceRoot = join(probeRoot, "workspace");
const sandboxRoot = join(probeRoot, "sandbox-root");
const stagedNodeDir = join(sandboxRoot, "tools", "node");
const stagedNode = join(stagedNodeDir, basename(process.execPath));

const descendantStarted = join(workspaceRoot, "descendant-started.txt");
const descendantSurvived = join(workspaceRoot, "descendant-survived.txt");
const outerDone = join(workspaceRoot, "outer-done.txt");

try {
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(stagedNodeDir, { recursive: true });
  await copyFile(process.execPath, stagedNode);

  const descendantSource = `import { writeFile } from "node:fs/promises";

const [startedPath, survivedPath] = process.argv.slice(1);
await writeFile(startedPath, "started", "utf8");
await new Promise((resolve) => setTimeout(resolve, 2500));
await writeFile(survivedPath, "survived", "utf8");
`;

  const outerSource = `import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const [
  stagedNode,
  descendantSource,
  startedPath,
  survivedPath,
  outerDonePath,
] = process.argv.slice(1);

const child = spawn(
  stagedNode,
  ["-e", descendantSource, startedPath, survivedPath],
  {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  },
);

child.unref();

const deadline = Date.now() + 1500;
while (Date.now() < deadline) {
  try {
    const { access } = await import("node:fs/promises");
    await access(startedPath);
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

await writeFile(
  outerDonePath,
  JSON.stringify({
    descendantPid: child.pid,
  }),
  "utf8",
);
`;

  const nodeDirectory = dirname(process.execPath);
  const rootToolPolicy = getAvailableToolsPolicy(
    { PATH: nodeDirectory },
    { containerType: "processcontainer" },
  );

  const config = createConfigFromPolicy(
    {
      version: "0.8.0-alpha",
      filesystem: {
        readwritePaths: [workspaceRoot],
        readonlyPaths: [
          sandboxRoot,
          ...rootToolPolicy.readonlyPaths,
        ],
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

  const commandLine = [
    process.execPath,
    "-e",
    outerSource,
    stagedNode,
    descendantSource,
    descendantStarted,
    descendantSurvived,
    outerDone,
  ]
    .map(quoteWindowsArgument)
    .join(" ");

  config.process!.commandLine = commandLine;
  config.process!.cwd = workspaceRoot;

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

  const outerCompleted = execution.exitCode === 0 && await exists(outerDone);
  const descendantStartedBeforeSandboxExit = await exists(descendantStarted);

  // Give a successfully detached descendant enough time to write its delayed
  // marker if it actually survives beyond the sandbox owner's lifetime.
  await new Promise((resolve) => setTimeout(resolve, 3200));

  const descendantSurvivedSandboxExit = await exists(descendantSurvived);
  const outerInfo = outerCompleted
    ? JSON.parse(await readFile(outerDone, "utf8"))
    : undefined;

  console.log(
    JSON.stringify(
      {
        probeExecuted: execution.exitCode === 0,
        sdk: "@microsoft/mxc-sdk@0.8.0",
        requestedContainment: "process",
        workspaceRoot,
        sandboxRoot,
        stagedNode,
        executor: execution,
        outerInfo,
        observations: {
          outerCompleted,
          descendantStartedBeforeSandboxExit,
          descendantSurvivedSandboxExit,
        },
        conclusions: {
          detachedDescendantSpawnWorks:
            outerCompleted && descendantStartedBeforeSandboxExit,
          detachedDescendantKilledOnSandboxExit:
            outerCompleted &&
            descendantStartedBeforeSandboxExit &&
            !descendantSurvivedSandboxExit,
        },
      },
      null,
      2,
    ),
  );

  if (
    execution.exitCode !== 0 ||
    !outerCompleted ||
    !descendantStartedBeforeSandboxExit
  ) {
    process.exitCode = 1;
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}
