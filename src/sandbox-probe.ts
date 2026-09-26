import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessCapability } from "./capabilities/process-capability.js";

interface ProbeChildResult {
  readonly inside: ReadAttempt;
  readonly directOutside: ReadAttempt;
  readonly reparseOutside: ReadAttempt | { readonly skipped: true; readonly reason: string };
}

interface ReadAttempt {
  readonly ok: boolean;
  readonly value?: string;
  readonly error?: string;
}

function parseChildOutput(stdout: string): ProbeChildResult {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error("Sandbox probe child produced no output.");
  }

  return JSON.parse(trimmed) as ProbeChildResult;
}

const probeRoot = await mkdtemp(join(tmpdir(), "junius-sandbox-probe-"));
const workspaceRoot = join(probeRoot, "workspace");
const outsideRoot = join(probeRoot, "outside");
const insideFile = join(workspaceRoot, "inside.txt");
const outsideFile = join(outsideRoot, "outside-secret.txt");
const reparseRoot = join(workspaceRoot, "outside-link");
const reparseFile = join(reparseRoot, "outside-secret.txt");
const childScript = join(workspaceRoot, "probe-child.mjs");

try {
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });

  await writeFile(insideFile, "inside-ok", "utf8");
  await writeFile(outsideFile, "outside-secret", "utf8");

  let reparseSetup:
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: string };

  try {
    await symlink(
      outsideRoot,
      reparseRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    reparseSetup = { ok: true };
  } catch (error) {
    reparseSetup = {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const childSource = `import { readFile } from "node:fs/promises";

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

const [, , insidePath, outsidePath, reparsePath, reparseEnabled] = process.argv;

const result = {
  inside: await attempt(insidePath),
  directOutside: await attempt(outsidePath),
  reparseOutside:
    reparseEnabled === "true"
      ? await attempt(reparsePath)
      : {
          skipped: true,
          reason: "junction/reparse setup failed in parent process",
        },
};

process.stdout.write(JSON.stringify(result));
`;

  await writeFile(childScript, childSource, "utf8");

  const args = [
    childScript,
    insideFile,
    outsideFile,
    reparseFile,
    String(reparseSetup.ok),
  ] as const;

  const capability = new ProcessCapability({
    key: "sandbox_probe",
    description:
      "Local-only security probe for child-process filesystem isolation.",
    executable: process.execPath,
    allowedArgVectors: [args],
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
    environment: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    },
  });

  const execution = await capability.execute(args, {
    cwd: workspaceRoot,
  });

  if (!execution.ok) {
    console.error(
      JSON.stringify(
        {
          probeExecuted: false,
          execution,
          workspaceRoot,
          outsideFile,
          reparseSetup,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } else {
    const child = parseChildOutput(execution.stdout);

    const report = {
      probeExecuted: true,
      workspaceRoot,
      outsideFile,
      reparseSetup,
      child,
      conclusions: {
        workspaceReadWorks:
          child.inside.ok && child.inside.value === "inside-ok",
        directOutsideReadBlocked: !child.directOutside.ok,
        reparseOutsideReadBlocked:
          "skipped" in child.reparseOutside
            ? null
            : !child.reparseOutside.ok,
      },
    };

    console.log(JSON.stringify(report, null, 2));
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}
