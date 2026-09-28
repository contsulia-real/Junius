import { spawn } from "node:child_process";
import { terminateProcessTree } from "../process-termination.js";
import type {
  CapabilityExecution,
  PreparedProcess,
} from "./types.js";

export async function executePreparedProcess(
  prepared: PreparedProcess,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<CapabilityExecution> {
  const startedAt = performance.now();

  return new Promise<CapabilityExecution>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let settled = false;
    let forcedFailure:
      | (() => CapabilityExecution)
      | undefined;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn(
      prepared.executable,
      [...prepared.args],
      {
        cwd: prepared.cwd,
        env: prepared.env,
        shell: false,
        windowsHide: prepared.windowsHide,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const durationMs = () =>
      Math.round(
        performance.now() - startedAt,
      );

    const capturedText = () => ({
      stdout: Buffer.concat(stdoutChunks)
        .toString("utf8"),
      stderr: Buffer.concat(stderrChunks)
        .toString("utf8"),
    });

    const finish = (
      result: CapabilityExecution,
    ): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const terminateWith = (
      result: () => CapabilityExecution,
    ): void => {
      if (
        settled ||
        forcedFailure !== undefined
      ) {
        return;
      }

      forcedFailure = result;

      void terminateProcessTree(
        child,
        prepared.env,
      ).finally(() => {
        if (
          settled ||
          forcedFailure === undefined
        ) {
          return;
        }

        finish(forcedFailure());
      });
    };

    const appendChunk = (
      target: Buffer[],
      chunk: Buffer | string,
    ): void => {
      if (
        settled ||
        forcedFailure !== undefined
      ) {
        return;
      }

      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk);
      capturedBytes += buffer.length;

      if (
        capturedBytes >
        maxOutputBytes
      ) {
        terminateWith(() => {
          const captured =
            capturedText();
          return {
            ok: false,
            code: "output_limit",
            message:
              `Process output exceeded ${maxOutputBytes} bytes.`,
            exitCode: child.exitCode,
            signal: child.signalCode,
            ...captured,
            durationMs: durationMs(),
          };
        });
        return;
      }

      target.push(buffer);
    };

    child.stdout.on(
      "data",
      (chunk: Buffer | string) => {
        appendChunk(
          stdoutChunks,
          chunk,
        );
      },
    );

    child.stderr.on(
      "data",
      (chunk: Buffer | string) => {
        appendChunk(
          stderrChunks,
          chunk,
        );
      },
    );

    child.once("error", (error) => {
      if (
        forcedFailure !== undefined
      ) {
        return;
      }

      const captured = capturedText();
      finish({
        ok: false,
        code: "spawn_failed",
        message: error.message,
        exitCode: null,
        signal: null,
        ...captured,
        durationMs: durationMs(),
      });
    });

    child.once(
      "close",
      (exitCode, signal) => {
        if (
          settled ||
          forcedFailure !== undefined
        ) {
          return;
        }

        const captured =
          capturedText();

        if (exitCode === 0) {
          finish({
            ok: true,
            exitCode,
            ...captured,
            durationMs:
              durationMs(),
          });
          return;
        }

        finish({
          ok: false,
          code: "nonzero_exit",
          message:
            `Process exited with code ${String(exitCode)}.`,
          exitCode,
          signal,
          ...captured,
          durationMs:
            durationMs(),
        });
      },
    );

    timer = setTimeout(() => {
      terminateWith(() => {
        const captured =
          capturedText();
        return {
          ok: false,
          code: "process_timeout",
          message:
            `Process exceeded timeout of ${timeoutMs} ms.`,
          exitCode: child.exitCode,
          signal: child.signalCode,
          ...captured,
          durationMs:
            durationMs(),
        };
      });
    }, timeoutMs);
  });
}
