import { once } from "node:events";
import {
  copyFile,
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

interface ReadAttempt {
  readonly ok: boolean;
  readonly value?: string;
  readonly error?: string;
}

interface ProbeResult {
  readonly nested: {
    readonly status: number | null;
    readonly signal: string | null;
    readonly error?: string;
    readonly stdout: string;
    readonly stderr: string;
  };
  readonly parsed?: {
    readonly workspaceViaPortal: ReadAttempt;
    readonly outside: ReadAttempt;
  };
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
  throw new Error("The MXC sandbox-root probe must run on Windows.");
}

const probeRootRaw = await mkdtemp(join(tmpdir(), "junius-mxc-root-"));
const probeRoot = await realpath(probeRootRaw);

const actualWorkspace = join(probeRoot, "actual-workspace");
const outsideRoot = join(probeRoot, "outside");
const sandboxRoot = join(probeRoot, "sandbox-root");
const toolsRoot = join(sandboxRoot, "tools");
const stagedNodeDirectory = join(toolsRoot, "node");
const stagedNode = join(stagedNodeDirectory, basename(process.execPath));
const workspacePortal = join(sandboxRoot, "workspace");

const insideFile = join(actualWorkspace, "inside.txt");
const portalInsideFile = join(workspacePortal, "inside.txt");
const outsideFile = join(outsideRoot, "outside-secret.txt");
const resultFile = join(actualWorkspace, "sandbox-root-result.json");

try {
  await mkdir(actualWorkspace, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await mkdir(stagedNodeDirectory, { recursive: true });

  await writeFile(insideFile, "inside-ok", "utf8");
  await writeFile(outsideFile, "outside-secret", "utf8");

  // Stage the exact already-authorized executable into a Junius-owned runtime
  // root. This is intentionally outside the user's Workspace.
  await copyFile(process.execPath, stagedNode);

  // Expose the real Workspace through a portal in the controlled runtime
  // namespace. The target itself is separately granted read/write.
  await symlink(actualWorkspace, workspacePortal, "junction");

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

const [portalInsidePath, outsidePath] = process.argv.slice(1);

process.stdout.write(JSON.stringify({
  workspaceViaPortal: await attempt(portalInsidePath),
  outside: await attempt(outsidePath),
}));
`;

  const outerSource = `import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const [
  stagedNode,
  nestedSource,
  portalInsidePath,
  outsidePath,
  resultPath,
] = process.argv.slice(1);

const nested = spawnSync(
  stagedNode,
  ["-e", nestedSource, portalInsidePath, outsidePath],
  {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  },
);

let parsed;
try {
  parsed = nested.stdout ? JSON.parse(nested.stdout) : undefined;
} catch {
  parsed = undefined;
}

await writeFile(
  resultPath,
  JSON.stringify({
    nested: {
      status: nested.status,
      signal: nested.signal,
      error: nested.error?.message,
      stdout: nested.stdout ?? "",
      stderr: nested.stderr ?? "",
    },
    parsed,
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
        readwritePaths: [actualWorkspace],
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
    nestedSource,
    portalInsideFile,
    outsideFile,
    resultFile,
  ]
    .map(quoteWindowsArgument)
    .join(" ");

  config.process!.commandLine = commandLine;
  config.process!.cwd = actualWorkspace;

  const child = spawnSandboxFromConfig(
    config,
    {
      usePty: false,
      experimental: true,
      debug: true,
    },
    actualWorkspace,
  );

  const execution = await waitForChild(child);

  if (execution.exitCode !== 0) {
    console.error(
      JSON.stringify(
        {
          probeExecuted: false,
          sdk: "@microsoft/mxc-sdk@0.8.0",
          execution,
          actualWorkspace,
          sandboxRoot,
          stagedNode,
          outsideFile,
          rootToolPolicy,
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

    const stagedToolSpawnWorks =
      result.nested.status === 0 &&
      result.nested.error === undefined &&
      result.parsed !== undefined;

    console.log(
      JSON.stringify(
        {
          probeExecuted: true,
          sdk: "@microsoft/mxc-sdk@0.8.0",
          requestedContainment: "process",
          actualWorkspace,
          sandboxRoot,
          stagedNode,
          workspacePortal,
          outsideFile,
          rootToolPolicy,
          executor: execution,
          result,
          conclusions: {
            stagedToolSpawnWorks,
            workspacePortalReadWorks:
              stagedToolSpawnWorks &&
              result.parsed?.workspaceViaPortal.ok === true &&
              result.parsed.workspaceViaPortal.value === "inside-ok",
            outsideReadBlocked:
              stagedToolSpawnWorks &&
              result.parsed?.outside.ok === false,
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
