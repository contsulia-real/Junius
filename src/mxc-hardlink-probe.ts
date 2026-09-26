import { once } from "node:events";
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  createConfigFromPolicy,
  spawnSandboxFromConfig,
} from "@microsoft/mxc-sdk";

interface Attempt {
  readonly ok: boolean;
  readonly value?: string;
  readonly error?: string;
}

interface ProbeResult {
  readonly hardlinkRead: Attempt;
  readonly hardlinkWrite: Attempt;
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
  throw new Error("The MXC hard-link probe must run on Windows.");
}

const probeRootRaw = await mkdtemp(join(tmpdir(), "junius-mxc-hardlink-"));
const probeRoot = await realpath(probeRootRaw);

const workspaceRoot = join(probeRoot, "workspace");
const outsideRoot = join(probeRoot, "outside");
const outsideFile = join(outsideRoot, "outside-secret.txt");
const workspaceHardlink = join(workspaceRoot, "outside-hardlink.txt");
const resultFile = join(workspaceRoot, "hardlink-result.json");

try {
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(outsideFile, "outside-original", "utf8");

  // Create the hard link before sandbox launch. Both paths are on the same
  // temporary volume, so this tests a Workspace path naming the exact same
  // underlying NTFS file object as the outside path.
  await link(outsideFile, workspaceHardlink);

  const sandboxSource = `import { readFile, writeFile } from "node:fs/promises";

async function readAttempt(path) {
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

async function writeAttempt(path) {
  try {
    await writeFile(path, "hardlink-overwritten", "utf8");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const [hardlinkPath, resultPath] = process.argv.slice(1);

const result = {
  hardlinkRead: await readAttempt(hardlinkPath),
  hardlinkWrite: await writeAttempt(hardlinkPath),
};

await writeFile(resultPath, JSON.stringify(result), "utf8");
`;

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
    workspaceHardlink,
    resultFile,
  ]
    .map(quoteWindowsArgument)
    .join(" ");
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
          workspaceHardlink,
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

    const outsideValue = await readFile(outsideFile, "utf8");
    const hardlinkValue = await readFile(workspaceHardlink, "utf8");

    console.log(
      JSON.stringify(
        {
          probeExecuted: true,
          sdk: "@microsoft/mxc-sdk@0.8.0",
          requestedContainment: "process",
          workspaceRoot,
          outsideFile,
          workspaceHardlink,
          executor: execution,
          result,
          hostVerification: {
            outsideValue,
            hardlinkValue,
            sameValue:
              outsideValue === hardlinkValue,
          },
          conclusions: {
            hardlinkOutsideReadBlocked:
              result.hardlinkRead.ok === false,
            hardlinkOutsideWriteBlocked:
              result.hardlinkWrite.ok === false &&
              outsideValue === "outside-original" &&
              hardlinkValue === "outside-original",
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
