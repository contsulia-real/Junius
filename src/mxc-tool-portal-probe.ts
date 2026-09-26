import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  createConfigFromPolicy,
  getAvailableToolsPolicy,
  spawnSandboxFromConfig,
} from "@microsoft/mxc-sdk";

interface AttemptResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error?: string;
  readonly stdout: string;
  readonly stderr: string;
}

interface ChildReadResult {
  readonly inside: {
    readonly ok: boolean;
    readonly value?: string;
    readonly error?: string;
  };
  readonly outside: {
    readonly ok: boolean;
    readonly value?: string;
    readonly error?: string;
  };
}

interface ProbeResult {
  readonly direct: AttemptResult;
  readonly portal: AttemptResult;
  readonly portalParsed?: ChildReadResult;
}

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

if (process.platform !== "win32") {
  throw new Error("The MXC tool-portal probe must run on Windows.");
}

const probeRootRaw = await mkdtemp(join(tmpdir(), "junius-mxc-tool-portal-"));
const probeRoot = await realpath(probeRootRaw);
const workspaceRoot = join(probeRoot, "workspace");
const outsideRoot = join(probeRoot, "outside");
const insideFile = join(workspaceRoot, "inside.txt");
const outsideFile = join(outsideRoot, "outside-secret.txt");
const resultFile = join(workspaceRoot, "tool-portal-result.json");
const portalRoot = join(workspaceRoot, ".junius-tools");
const nodePortal = join(portalRoot, "node");
const nodeDirectory = dirname(process.execPath);
const portalNode = join(nodePortal, basename(process.execPath));

try {
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await mkdir(portalRoot, { recursive: true });
  await writeFile(insideFile, "inside-ok", "utf8");
  await writeFile(outsideFile, "outside-secret", "utf8");
  await symlink(nodeDirectory, nodePortal, "junction");

  const nestedSource = `import { readFile } from "node:fs/promises";

async function attempt(path) {
  try {
    return {
      ok: true,
      value: await readFile(path, "utf8"),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const [insidePath, outsidePath] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  inside: await attempt(insidePath),
  outside: await attempt(outsidePath),
}));
`;

  const outerSource = `import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const [
  directNode,
  portalNode,
  nestedSource,
  insidePath,
  outsidePath,
  resultPath,
] = process.argv.slice(1);

function run(executable) {
  const child = spawnSync(
    executable,
    ["-e", nestedSource, insidePath, outsidePath],
    {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    },
  );

  return {
    status: child.status,
    signal: child.signal,
    error: child.error?.message,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
}

const direct = run(directNode);
const portal = run(portalNode);

let portalParsed;
try {
  portalParsed = portal.stdout
    ? JSON.parse(portal.stdout)
    : undefined;
} catch {
  portalParsed = undefined;
}

await writeFile(
  resultPath,
  JSON.stringify({ direct, portal, portalParsed }),
  "utf8",
);
`;

  const toolPolicy = getAvailableToolsPolicy(
    { PATH: nodeDirectory },
    { containerType: "processcontainer" },
  );

  const config = createConfigFromPolicy(
    {
      version: "0.8.0-alpha",
      filesystem: {
        readwritePaths: [workspaceRoot],
        readonlyPaths: toolPolicy.readonlyPaths,
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
    process.execPath,
    portalNode,
    nestedSource,
    insideFile,
    outsideFile,
    resultFile,
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

  if (execution.exitCode !== 0) {
    console.error(
      JSON.stringify(
        {
          probeExecuted: false,
          sdk: "@microsoft/mxc-sdk@0.8.0",
          execution,
          workspaceRoot,
          nodeDirectory,
          portalNode,
          toolPolicy,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } else {
    const result = JSON.parse(
      await readFile(resultFile, "utf8"),
    ) as ProbeResult;

    const portalSpawnWorks =
      result.portal.status === 0 &&
      result.portal.error === undefined &&
      result.portalParsed !== undefined;

    console.log(
      JSON.stringify(
        {
          probeExecuted: true,
          sdk: "@microsoft/mxc-sdk@0.8.0",
          requestedContainment: "process",
          workspaceRoot,
          nodeDirectory,
          portalNode,
          toolPolicy,
          executor: execution,
          result,
          conclusions: {
            directExternalSpawnWorks:
              result.direct.status === 0 &&
              result.direct.error === undefined,
            portalSpawnWorks,
            portalInsideReadWorks:
              portalSpawnWorks &&
              result.portalParsed?.inside.ok === true &&
              result.portalParsed.inside.value === "inside-ok",
            portalOutsideReadBlocked:
              portalSpawnWorks &&
              result.portalParsed?.outside.ok === false,
          },
        },
        null,
        2,
      ),
    );
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}
