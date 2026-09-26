import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

interface ChildProbeResult {
  readonly inside: ReadAttempt;
  readonly directOutside: ReadAttempt;
  readonly reparseOutside: ReadAttempt;
}

function quoteWindowsArgument(value: string): string {
  if (value.length === 0) {
    return '""';
  }

  if (!/[\s"]/u.test(value)) {
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
  throw new Error("The MXC Windows sandbox probe must run on Windows.");
}

const probeRootRaw = await mkdtemp(join(tmpdir(), "junius-mxc-sandbox-"));
const probeRoot = await realpath(probeRootRaw);
const workspaceRoot = join(probeRoot, "workspace");
const outsideRoot = join(probeRoot, "outside");
const insideFile = join(workspaceRoot, "inside.txt");
const outsideFile = join(outsideRoot, "outside-secret.txt");
const reparseRoot = join(workspaceRoot, "outside-link");
const reparseFile = join(reparseRoot, "outside-secret.txt");
const childScript = join(workspaceRoot, "probe-child.mjs");
const resultFile = join(workspaceRoot, "result.json");

try {
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(insideFile, "inside-ok", "utf8");
  await writeFile(outsideFile, "outside-secret", "utf8");

  let reparseSetup:
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: string };

  try {
    await symlink(outsideRoot, reparseRoot, "junction");
    reparseSetup = { ok: true };
  } catch (error) {
    reparseSetup = {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const childSource = `import { readFile, writeFile } from "node:fs/promises";

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

const [, , insidePath, outsidePath, reparsePath, resultPath] = process.argv;

const result = {
  inside: await attempt(insidePath),
  directOutside: await attempt(outsidePath),
  reparseOutside: await attempt(reparsePath),
};

await writeFile(resultPath, JSON.stringify(result), "utf8");
`;

  await writeFile(childScript, childSource, "utf8");

  // Only discover the directory containing the exact Node executable used by
  // this probe. Supplying the full host PATH could cause the SDK's PowerShell
  // helper to grant a drive root read-only, which would invalidate the escape
  // test by intentionally authorizing the outside file.
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
      timeoutMs: 10_000,
    },
    "process",
  );

  const commandLine = [
    process.execPath,
    childScript,
    insideFile,
    outsideFile,
    reparseFile,
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
    {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      TEMP: workspaceRoot,
      TMP: workspaceRoot,
    },
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
          reparseSetup,
          toolPolicy,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } else {
    const childResult = JSON.parse(
      await readFile(resultFile, "utf8"),
    ) as ChildProbeResult;

    console.log(
      JSON.stringify(
        {
          probeExecuted: true,
          sdk: "@microsoft/mxc-sdk@0.8.0",
          requestedContainment: "process",
          workspaceRoot,
          outsideFile,
          reparseSetup,
          toolPolicy,
          executor: {
            exitCode: execution.exitCode,
            signal: execution.signal,
            stdout: execution.stdout,
            stderr: execution.stderr,
          },
          child: childResult,
          conclusions: {
            workspaceReadWorks:
              childResult.inside.ok &&
              childResult.inside.value === "inside-ok",
            directOutsideReadBlocked: !childResult.directOutside.ok,
            reparseOutsideReadBlocked:
              reparseSetup.ok
                ? !childResult.reparseOutside.ok
                : null,
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
