import { once } from "node:events";
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

interface NestedExecution {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error?: string;
  readonly stdout: string;
  readonly stderr: string;
}

interface ProbeResult {
  readonly nested: NestedExecution;
  readonly parsed?: {
    readonly inside: ReadAttempt;
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
  throw new Error("The MXC descendant-process probe must run on Windows.");
}

const probeRootRaw = await mkdtemp(join(tmpdir(), "junius-mxc-child-"));
const probeRoot = await realpath(probeRootRaw);
const workspaceRoot = join(probeRoot, "workspace");
const outsideRoot = join(probeRoot, "outside");
const insideFile = join(workspaceRoot, "inside.txt");
const outsideFile = join(outsideRoot, "outside-secret.txt");
const resultFile = join(workspaceRoot, "child-result.json");
const nestedNode = join(workspaceRoot, "nested-node.exe");

try {
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(insideFile, "inside-ok", "utf8");
  await writeFile(outsideFile, "outside-secret", "utf8");
  // The first descendant probe tried to execute process.execPath directly
  // from the host tool directory and got ENOENT inside the sandbox. To
  // isolate descendant-token inheritance from executable-path reachability,
  // copy the same Node executable into the already-authorized Workspace and
  // launch the descendant from there.
  await copyFile(process.execPath, nestedNode);

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

const [nestedNode, nestedSource, insidePath, outsidePath, resultPath] =
  process.argv.slice(1);

const nested = spawnSync(
  nestedNode,
  ["-e", nestedSource, insidePath, outsidePath],
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
    nestedNode,
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
          outsideFile,
          nestedNode,
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

    const nestedSpawnWorks =
      result.nested.status === 0 &&
      result.nested.error === undefined &&
      result.parsed !== undefined;

    console.log(
      JSON.stringify(
        {
          probeExecuted: true,
          sdk: "@microsoft/mxc-sdk@0.8.0",
          requestedContainment: "process",
          workspaceRoot,
          outsideFile,
          nestedNode,
          toolPolicy,
          executor: execution,
          result,
          conclusions: {
            nestedSpawnWorks,
            nestedInsideReadWorks:
              nestedSpawnWorks &&
              result.parsed?.inside.ok === true &&
              result.parsed.inside.value === "inside-ok",
            nestedOutsideReadBlocked:
              nestedSpawnWorks &&
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
