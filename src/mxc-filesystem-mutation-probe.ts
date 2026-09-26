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
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  createConfigFromPolicy,
  spawnSandboxFromConfig,
} from "@microsoft/mxc-sdk";

interface Attempt {
  readonly ok: boolean;
  readonly error?: string;
}

interface ProbeResult {
  readonly insideWrite: Attempt;
  readonly directOutsideOverwrite: Attempt;
  readonly directOutsideCreate: Attempt;
  readonly reparseOutsideOverwrite: Attempt;
  readonly reparseOutsideCreate: Attempt;
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
  throw new Error("The MXC filesystem mutation probe must run on Windows.");
}

const probeRootRaw = await mkdtemp(join(tmpdir(), "junius-mxc-mutation-"));
const probeRoot = await realpath(probeRootRaw);

const workspaceRoot = join(probeRoot, "workspace");
const outsideRoot = join(probeRoot, "outside");

const insideTarget = join(workspaceRoot, "inside-write.txt");
const outsideExisting = join(outsideRoot, "outside-existing.txt");
const outsideCreated = join(outsideRoot, "outside-created.txt");

const outsideLink = join(workspaceRoot, "outside-link");
const reparseExisting = join(outsideLink, "outside-existing.txt");
const reparseCreated = join(outsideLink, "reparse-created.txt");

const resultFile = join(workspaceRoot, "mutation-result.json");

try {
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });

  await writeFile(outsideExisting, "outside-original", "utf8");
  await symlink(outsideRoot, outsideLink, "junction");

  const sandboxSource = `import { writeFile } from "node:fs/promises";

async function attempt(path, value) {
  try {
    await writeFile(path, value, "utf8");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const [
  insideTarget,
  outsideExisting,
  outsideCreated,
  reparseExisting,
  reparseCreated,
  resultPath,
] = process.argv.slice(1);

const result = {
  insideWrite: await attempt(insideTarget, "inside-written"),
  directOutsideOverwrite: await attempt(outsideExisting, "outside-overwritten"),
  directOutsideCreate: await attempt(outsideCreated, "outside-created"),
  reparseOutsideOverwrite: await attempt(reparseExisting, "reparse-overwritten"),
  reparseOutsideCreate: await attempt(reparseCreated, "reparse-created"),
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
    insideTarget,
    outsideExisting,
    outsideCreated,
    reparseExisting,
    reparseCreated,
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
          outsideRoot,
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

    const insideValue = await readFile(insideTarget, "utf8");
    const outsideExistingValue = await readFile(outsideExisting, "utf8");

    let outsideCreatedExists = true;
    try {
      await readFile(outsideCreated, "utf8");
    } catch {
      outsideCreatedExists = false;
    }

    let reparseCreatedExists = true;
    try {
      await readFile(join(outsideRoot, "reparse-created.txt"), "utf8");
    } catch {
      reparseCreatedExists = false;
    }

    console.log(
      JSON.stringify(
        {
          probeExecuted: true,
          sdk: "@microsoft/mxc-sdk@0.8.0",
          requestedContainment: "process",
          workspaceRoot,
          outsideRoot,
          executor: execution,
          result,
          hostVerification: {
            insideValue,
            outsideExistingValue,
            outsideCreatedExists,
            reparseCreatedExists,
          },
          conclusions: {
            workspaceWriteWorks:
              result.insideWrite.ok === true &&
              insideValue === "inside-written",
            directOutsideOverwriteBlocked:
              result.directOutsideOverwrite.ok === false &&
              outsideExistingValue === "outside-original",
            directOutsideCreateBlocked:
              result.directOutsideCreate.ok === false &&
              outsideCreatedExists === false,
            reparseOutsideOverwriteBlocked:
              result.reparseOutsideOverwrite.ok === false &&
              outsideExistingValue === "outside-original",
            reparseOutsideCreateBlocked:
              result.reparseOutsideCreate.ok === false &&
              reparseCreatedExists === false,
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
