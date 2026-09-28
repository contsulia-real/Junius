import {
  spawn,
} from "node:child_process";
import {
  readFileSync,
  writeFileSync,
} from "node:fs";

const payloadFile =
  process.env.JUNIUS_JOB_PAYLOAD_FILE;
if (
  payloadFile === undefined ||
  payloadFile.length === 0
) {
  throw new Error(
    "job_bootstrap_payload_file_missing",
  );
}

let payloadText;
for (;;) {
  try {
    payloadText = readFileSync(
      payloadFile,
      "utf8",
    );
    break;
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )
    ) {
      throw error;
    }

    await new Promise(
      (resolvePromise) =>
        setTimeout(resolvePromise, 10),
    );
  }
}

const payload =
  JSON.parse(payloadText);

const readyFile =
  process.env.JUNIUS_JOB_READY_FILE;
if (
  readyFile === undefined ||
  readyFile.length === 0
) {
  throw new Error(
    "job_bootstrap_ready_file_missing",
  );
}

const environment = {
  ...process.env,
};
delete environment.JUNIUS_JOB_READY_FILE;
delete environment.JUNIUS_JOB_PAYLOAD_FILE;

const child = spawn(
  payload.executable,
  payload.args,
  {
    cwd: payload.cwd,
    env: environment,
    shell: false,
    windowsHide:
      Boolean(payload.windowsHide),
    stdio: [
      "ignore",
      "inherit",
      "inherit",
    ],
  },
);

child.once("spawn", () => {
  writeFileSync(
    readyFile,
    String(child.pid),
    "ascii",
  );
});

child.once("error", (error) => {
  console.error(
    "job_bootstrap_spawn_failed:",
    error,
  );
  process.exitCode = 1;
});

child.once(
  "exit",
  (code, signal) => {
    if (code !== null) {
      process.exitCode = code;
      return;
    }

    console.error(
      "job_bootstrap_payload_signalled:",
      signal,
    );
    process.exitCode = 1;
  },
);
