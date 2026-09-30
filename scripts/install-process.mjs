import { spawn } from "node:child_process";
import {
  access,
  stat,
} from "node:fs/promises";

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function isFile(path) {
  try {
    return (
      await stat(path)
    ).isFile();
  } catch {
    return false;
  }
}

export async function runProcess(
  executable,
  args,
  options = {},
) {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(
      executable,
      args,
      {
        cwd: options.cwd,
        env:
          options.env ??
          process.env,
        shell: false,
        windowsHide: true,
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      },
    );

    const finish = (
      result,
    ) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        ...result,
        stdout,
        stderr,
      });
    };

    child.stdout.setEncoding(
      "utf8",
    );
    child.stderr.setEncoding(
      "utf8",
    );
    child.stdout.on(
      "data",
      (chunk) => {
        stdout += chunk;
      },
    );
    child.stderr.on(
      "data",
      (chunk) => {
        stderr += chunk;
      },
    );
    child.once(
      "error",
      (error) => {
        finish({
          ok: false,
          exitCode: null,
          signal: null,
          error,
        });
      },
    );
    child.once(
      "close",
      (
        exitCode,
        signal,
      ) => {
        finish({
          ok:
            exitCode === 0,
          exitCode,
          signal,
        });
      },
    );
  });
}

export async function assertProcess(
  label,
  executable,
  args,
  options,
) {
  const result =
    await runProcess(
      executable,
      args,
      options,
    );

  if (!result.ok) {
    const detail = [
      result.stderr.trim(),
      result.stdout.trim(),
    ]
      .filter(Boolean)
      .join("\n");

    throw new Error(
      `${label} failed` +
      (
        detail
          ? `:\n${detail}`
          : "."
      ),
    );
  }

  return result;
}
