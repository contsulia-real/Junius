import { randomBytes } from "node:crypto";
import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { rmSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { environmentForSpawn } from "./execution-environment.js";
import { terminateProcessTree } from "./process-termination.js";
import type { PreparedProcess } from "./process-types.js";

const READY_PREFIX =
  "@@JUNIUS_JOB_READY@@:";
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_HANDSHAKE_BYTES = 4 * 1024;

const STALE_JOB_TEMP_AGE_MS = 24 * 60 * 60 * 1_000;
const JOB_TEMP_FILE_PATTERN =
  /^junius-job-(?:ready-[a-f0-9]{32}\.txt|payload-[a-f0-9]{32}\.(?:json|tmp))$/u;
let staleCleanup: Promise<void> | undefined;

export function cleanupStaleJobTempFiles(): Promise<void> {
  if (process.platform !== "win32") {
    return Promise.resolve();
  }
  return (staleCleanup ??= (async () => {
    const directory = tmpdir();
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !JOB_TEMP_FILE_PATTERN.test(entry.name)) continue;
      const path = join(directory, entry.name);
      try {
        const info = await lstat(path);
        if (!info.isFile() || Date.now() - info.mtimeMs < STALE_JOB_TEMP_AGE_MS) continue;
        await rm(path, { force: true });
      } catch {
        // The owning guardian may have removed it concurrently.
      }
    }
  })());
}

export interface JobProcessController {
  readonly child: ChildProcess;
  readonly pid: number | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

function spawnDirect(
  prepared: PreparedProcess,
): JobProcessController {
  const child = spawn(
    prepared.executable,
    [...prepared.args],
    {
      cwd: prepared.cwd,
      env: environmentForSpawn(
        prepared.env,
      ),
      shell: false,
      windowsHide:
        prepared.windowsHide,
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    },
  );

  if (
    child.stdout === null ||
    child.stderr === null
  ) {
    throw new Error(
      "job_process_stdio_unavailable",
    );
  }

  return {
    child,
    pid: child.pid ?? null,
    stdout: child.stdout,
    stderr: child.stderr,
  };
}

function windowsPowerShell(
  environment: NodeJS.ProcessEnv,
): string {
  const systemRoot =
    environment.SystemRoot ??
    environment.SYSTEMROOT ??
    process.env.SystemRoot ??
    process.env.SYSTEMROOT ??
    "C:\\Windows";

  return join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

async function spawnWindowsGuardian(
  prepared: PreparedProcess,
): Promise<JobProcessController> {
  const guardianPath = fileURLToPath(
    new URL(
      "./windows-job-guardian.ps1",
      import.meta.url,
    ),
  );
  const environment = environmentForSpawn(
    prepared.env,
  );
  const nonce = randomBytes(16).toString("hex");
  const tempDirectory = tmpdir();
  const child = spawn(
    windowsPowerShell(environment),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      guardianPath,
    ],
    {
      cwd: prepared.cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: [
        "pipe",
        "pipe",
        "pipe",
      ],
    },
  );

  // Forced process-tree termination bypasses the guardian's finally.
  child.once("close", () => {
    for (const name of [
      `junius-job-ready-${nonce}.txt`,
      `junius-job-payload-${nonce}.json`,
      `junius-job-payload-${nonce}.tmp`,
    ]) {
      try {
        rmSync(join(tempDirectory, name), { force: true });
      } catch {
        // Startup cleanup will retry after an abnormal exit.
      }
    }
  });

  if (
    child.stdin === null ||
    child.stdout === null ||
    child.stderr === null
  ) {
    await terminateProcessTree(
      child,
      environment,
    );
    throw new Error(
      "job_guardian_stdio_unavailable",
    );
  }

  const userStderr = new PassThrough();
  let pending = Buffer.alloc(0);
  let ready = false;

  const payload = Buffer.from(
    JSON.stringify({
      nonce,
      executable: prepared.executable,
      args: [...prepared.args],
      cwd: prepared.cwd,
      windowsHide:
        prepared.windowsHide,
      bootstrapExecutable:
        process.execPath,
      bootstrapPath:
        fileURLToPath(
          new URL(
            "./job-bootstrap.mjs",
            import.meta.url,
          ),
        ),
      ownerPid: process.pid,
      hostPid:
        process.env.JUNIUS_HOST_PID === undefined
          ? null
          : Number(process.env.JUNIUS_HOST_PID),
    }),
    "utf8",
  ).toString("base64");

  const pid = await new Promise<number>(
    (resolve, reject) => {
      let settled = false;

      const finish = (
        error: Error | undefined,
        value?: number,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("error", onError);
        child.off("close", onClose);

        if (error !== undefined) {
          reject(error);
        } else {
          resolve(value!);
        }
      };

      const onError = (error: Error) => {
        finish(error);
      };

      const onClose = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (!ready) {
          finish(
            new Error(
              "job_guardian_exited_before_ready:" +
                " exit=" +
                String(exitCode) +
                " signal=" +
                String(signal),
            ),
          );
        }
      };

      child.stderr!.on(
        "data",
        (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(
            chunk,
          )
            ? chunk
            : Buffer.from(chunk);

          if (ready) {
            userStderr.write(buffer);
            return;
          }

          pending = Buffer.concat([
            pending,
            buffer,
          ]);

          if (
            pending.length >
            MAX_HANDSHAKE_BYTES
          ) {
            finish(
              new Error(
                "job_guardian_handshake_too_large",
              ),
            );
            return;
          }

          const newline =
            pending.indexOf(0x0a);
          if (newline < 0) {
            return;
          }

          const line = pending
            .subarray(0, newline)
            .toString("ascii")
            .replace(/\r$/u, "");
          const remainder =
            pending.subarray(
              newline + 1,
            );
          pending = Buffer.alloc(0);

          if (
            !line.startsWith(
              READY_PREFIX,
            )
          ) {
            finish(
              new Error(
                "job_guardian_invalid_handshake:" +
                  line,
              ),
            );
            return;
          }

          const parsed = Number(
            line.slice(
              READY_PREFIX.length,
            ),
          );
          if (
            !Number.isSafeInteger(parsed) ||
            parsed <= 0
          ) {
            finish(
              new Error(
                "job_guardian_invalid_pid",
              ),
            );
            return;
          }

          ready = true;
          if (remainder.length > 0) {
            userStderr.write(remainder);
          }
          finish(undefined, parsed);
        },
      );

      child.stderr!.once(
        "end",
        () => {
          userStderr.end();
        },
      );
      child.once("error", onError);
      child.once("close", onClose);

      const timer = setTimeout(
        () => {
          finish(
            new Error(
              "job_guardian_handshake_timeout",
            ),
          );
        },
        HANDSHAKE_TIMEOUT_MS,
      );

      child.stdin!.end(
        payload + "\n",
        "ascii",
      );
    },
  ).catch(async (error: unknown) => {
    await terminateProcessTree(
      child,
      environment,
    ).catch(() => undefined);
    throw error;
  });

  return {
    child,
    pid,
    stdout: child.stdout,
    stderr: userStderr,
  };
}

export async function spawnJobProcess(
  prepared: PreparedProcess,
  platform: NodeJS.Platform =
    process.platform,
): Promise<JobProcessController> {
  if (platform !== "win32") {
    return spawnDirect(prepared);
  }

  return spawnWindowsGuardian(
    prepared,
  );
}
