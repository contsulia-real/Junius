import assert from "node:assert/strict";
import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  join,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline =
    Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, 50),
    );
  }

  throw new Error("condition_timeout");
}

async function heartbeatSize(
  path: string,
): Promise<number> {
  try {
    return (
      await readFile(path)
    ).length;
  } catch {
    return 0;
  }
}

function processAlive(
  pid: number,
): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForReady(
  child: ChildProcess,
): Promise<{
  readonly payloadPid: number;
  readonly guardianPid: number;
}> {
  return new Promise(
    (resolvePromise, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (
        error: Error | undefined,
        value?: {
          payloadPid: number;
          guardianPid: number;
        },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (error !== undefined) {
          reject(error);
        } else {
          resolvePromise(value!);
        }
      };

      child.stdout?.on(
        "data",
        (chunk: Buffer | string) => {
          stdout += chunk.toString();
          const match =
            /^READY (\d+) (\d+)\r?$/mu.exec(
              stdout,
            );
          if (match === null) {
            return;
          }

          finish(undefined, {
            payloadPid: Number(
              match[1],
            ),
            guardianPid: Number(
              match[2],
            ),
          });
        },
      );

      child.stderr?.on(
        "data",
        (chunk: Buffer | string) => {
          stderr += chunk.toString();
        },
      );

      child.once(
        "exit",
        (code, signal) => {
          finish(
            new Error(
              `owner_exited_before_ready: code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
            ),
          );
        },
      );

      const timer = setTimeout(
        () => {
          finish(
            new Error(
              `owner_ready_timeout: stdout=${stdout} stderr=${stderr}`,
            ),
          );
        },
        15_000,
      );
    },
  );
}

test(
  "Windows job guardian kills descendant tree when owner crashes",
  {
    skip:
      process.platform !== "win32",
  },
  async () => {
    const root = await mkdtemp(
      join(
        tmpdir(),
        "junius-job-guardian-",
      ),
    );
    const heartbeat = join(
      root,
      "heartbeat.txt",
    );
    const ownerScript = join(
      root,
      "owner.ts",
    );
    let owner:
      | ChildProcess
      | undefined;
    let ready:
      | {
          payloadPid: number;
          guardianPid: number;
        }
      | undefined;

    try {
      const grandchildScript =
        `const fs=require("node:fs");setInterval(()=>fs.appendFileSync(${JSON.stringify(
          heartbeat,
        )},"x"),50);`;

      const payloadScript =
        `const {spawn}=require("node:child_process");spawn(process.execPath,["-e",${JSON.stringify(
          grandchildScript,
        )}],{stdio:"ignore"});setInterval(()=>{},1000);`;

      const controllerUrl =
        pathToFileURL(
          resolve(
            "src",
            "job-process-controller.ts",
          ),
        ).href;

      await writeFile(
        ownerScript,
        `import { spawnJobProcess } from ${JSON.stringify(
          controllerUrl,
        )};
void (async () => {
  const controller = await spawnJobProcess({
    executable: process.execPath,
    args: ["-e", ${JSON.stringify(
      payloadScript,
    )}],
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
  });
  process.stdout.write(
    "READY " +
      String(controller.pid) +
      " " +
      String(controller.child.pid) +
      "\\n",
  );
  setInterval(() => {}, 1000);
})();
`,
        "utf8",
      );

      const environment = {
        ...process.env,
      };
      delete environment
        .JUNIUS_HOST_PID;

      owner = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          ownerScript,
        ],
        {
          cwd: process.cwd(),
          env: environment,
          shell: false,
          windowsHide: true,
          stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],
        },
      );

      ready =
        await waitForReady(owner);

      assert.equal(
        Number.isSafeInteger(
          ready.payloadPid,
        ) &&
          ready.payloadPid > 0,
        true,
      );
      assert.equal(
        Number.isSafeInteger(
          ready.guardianPid,
        ) &&
          ready.guardianPid > 0,
        true,
      );

      await waitUntil(
        async () =>
          (await heartbeatSize(
            heartbeat,
          )) >= 2,
        5_000,
      );

      const ownerExit = once(
        owner,
        "exit",
      );
      owner.kill("SIGKILL");
      await ownerExit;

      await waitUntil(
        async () =>
          !processAlive(
            ready!.guardianPid,
          ),
        2_000,
      );

      const payloadAliveAfterGuardian =
        processAlive(
          ready.payloadPid,
        );

      await new Promise(
        (resolvePromise) =>
          setTimeout(
            resolvePromise,
            200,
          ),
      );
      const stoppedAt =
        await heartbeatSize(
          heartbeat,
        );

      await new Promise(
        (resolvePromise) =>
          setTimeout(
            resolvePromise,
            400,
          ),
      );

      assert.equal(
        await heartbeatSize(
          heartbeat,
        ),
        stoppedAt,
        `heartbeat_continued_after_guardian_exit payloadAlive=${String(
          payloadAliveAfterGuardian,
        )}`,
      );
    } finally {
      if (
        owner !== undefined &&
        owner.exitCode === null &&
        owner.signalCode === null
      ) {
        owner.kill("SIGKILL");
      }

      if (
        ready !== undefined &&
        processAlive(
          ready.guardianPid,
        )
      ) {
        try {
          process.kill(
            ready.guardianPid,
            "SIGKILL",
          );
        } catch {
          // Already gone.
        }
      }

      await new Promise(
        (resolvePromise) =>
          setTimeout(
            resolvePromise,
            150,
          ),
      );

      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);
