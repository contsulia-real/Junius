import { spawn } from "node:child_process";
import { terminateProcessTree } from "./process-termination.js";
import type { PlaywrightCliLauncher } from "./playwright-cli-launcher.js";
import {
  PlaywrightCliError,
  type PlaywrightCliCommand,
  type PlaywrightCliErrorCode,
  type PlaywrightCliExecution,
} from "./playwright-cli-types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface PlaywrightCliSpawnExecutionOptions {
  readonly launcher: PlaywrightCliLauncher;
  readonly cliArgs: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly session: string;
  readonly command: PlaywrightCliCommand;
  readonly startedAt: number;
}

export function runPlaywrightCliSpawn(
  options: PlaywrightCliSpawnExecutionOptions,
): Promise<PlaywrightCliExecution> {
  return new Promise<PlaywrightCliExecution>(
    (resolvePromise, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let timedOut = false;
      let outputLimit = false;

      const child = spawn(
        options.launcher.executable,
        [
          ...options.launcher.fixedArgs,
          ...options.cliArgs,
        ],
        {
          cwd: options.cwd,
          env: options.environment,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const finishError = (
        code: PlaywrightCliErrorCode,
        message: string,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new PlaywrightCliError(code, message));
      };

      const append = (
        target: Buffer[],
        chunk: Buffer | string,
      ) => {
        if (settled) return;

        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk);

        bytes += buffer.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          if (!outputLimit) {
            outputLimit = true;
            void terminateProcessTree(
              child,
              options.environment,
            );
          }
          return;
        }

        target.push(buffer);
      };

      child.stdout.on(
        "data",
        (chunk: Buffer | string) => {
          append(stdout, chunk);
        },
      );
      child.stderr.on(
        "data",
        (chunk: Buffer | string) => {
          append(stderr, chunk);
        },
      );

      child.once("error", (error) => {
        finishError("spawn_failed", error.message);
      });

      child.once("close", (exitCode) => {
        if (settled) return;

        if (outputLimit) {
          finishError(
            "output_limit",
            `playwright-cli output exceeded ${MAX_OUTPUT_BYTES} bytes.`,
          );
          return;
        }

        if (timedOut) {
          finishError(
            "process_timeout",
            `playwright-cli command exceeded ${DEFAULT_TIMEOUT_MS} ms.`,
          );
          return;
        }

        const stdoutText =
          Buffer.concat(stdout).toString("utf8");
        const stderrText =
          Buffer.concat(stderr).toString("utf8");

        if (exitCode !== 0) {
          finishError(
            "nonzero_exit",
            stderrText ||
              stdoutText ||
              `playwright-cli exited with code ${String(exitCode)}.`,
          );
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolvePromise({
          session: options.session,
          command: options.command,
          exitCode: 0,
          stdout: stdoutText,
          stderr: stderrText,
          durationMs: Math.round(
            performance.now() - options.startedAt,
          ),
          transport: "spawn",
        });
      });

      const timer = setTimeout(() => {
        timedOut = true;
        void terminateProcessTree(
          child,
          options.environment,
        );
      }, DEFAULT_TIMEOUT_MS);
    },
  );
}
