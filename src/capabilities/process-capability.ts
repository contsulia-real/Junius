import { spawn } from "node:child_process";
import type {
  Capability,
  CapabilityExecution,
  CapabilityExecutionContext,
} from "./types.js";

export interface ProcessCapabilityOptions {
  readonly key: string;
  readonly description: string;
  readonly executable: string;
  readonly allowedArgVectors: readonly (readonly string[])[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly environment?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

function matchesAllowedVector(
  args: readonly string[],
  allowed: readonly string[],
): boolean {
  return (
    args.length === allowed.length &&
    args.every((value, index) => value === allowed[index])
  );
}

export class ProcessCapability implements Capability {
  readonly key: string;
  readonly description: string;

  readonly #executable: string;
  readonly #allowedArgVectors: readonly (readonly string[])[];
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: ProcessCapabilityOptions) {
    this.key = options.key;
    this.description = options.description;
    this.#executable = options.executable;
    this.#allowedArgVectors = options.allowedArgVectors;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#environment = options.environment ?? {};
  }

  async execute(
    args: readonly string[],
    context: CapabilityExecutionContext,
  ): Promise<CapabilityExecution> {
    if (
      !this.#allowedArgVectors.some((allowed) =>
        matchesAllowedVector(args, allowed),
      )
    ) {
      return {
        ok: false,
        code: "arguments_not_allowed",
        message: `Arguments are not allowed for capability ${this.key}.`,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
      };
    }

    const startedAt = performance.now();

    return new Promise<CapabilityExecution>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let capturedBytes = 0;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const child = spawn(this.#executable, [...args], {
        cwd: context.cwd,
        env: this.#environment,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const durationMs = () => Math.round(performance.now() - startedAt);

      const capturedText = () => ({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });

      const finish = (result: CapabilityExecution): void => {
        if (settled) {
          return;
        }

        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolve(result);
      };

      const appendChunk = (
        target: Buffer[],
        chunk: Buffer | string,
      ): void => {
        if (settled) {
          return;
        }

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        capturedBytes += buffer.length;

        if (capturedBytes > this.#maxOutputBytes) {
          child.kill();
          const captured = capturedText();
          finish({
            ok: false,
            code: "output_limit",
            message: `Process output exceeded ${this.#maxOutputBytes} bytes.`,
            exitCode: null,
            signal: null,
            ...captured,
            durationMs: durationMs(),
          });
          return;
        }

        target.push(buffer);
      };

      child.stdout.on("data", (chunk: Buffer | string) => {
        appendChunk(stdoutChunks, chunk);
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        appendChunk(stderrChunks, chunk);
      });

      child.once("error", (error) => {
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

      child.once("close", (exitCode, signal) => {
        const captured = capturedText();

        if (exitCode === 0) {
          finish({
            ok: true,
            exitCode,
            ...captured,
            durationMs: durationMs(),
          });
          return;
        }

        finish({
          ok: false,
          code: "nonzero_exit",
          message: `Process exited with code ${String(exitCode)}.`,
          exitCode,
          signal,
          ...captured,
          durationMs: durationMs(),
        });
      });

      timer = setTimeout(() => {
        // This terminates only the directly spawned process. It is not a
        // process-tree sandbox; Windows Job Object isolation is a later spike.
        child.kill();
        const captured = capturedText();
        finish({
          ok: false,
          code: "process_timeout",
          message: `Process exceeded timeout of ${this.#timeoutMs} ms.`,
          exitCode: null,
          signal: null,
          ...captured,
          durationMs: durationMs(),
        });
      }, this.#timeoutMs);
    });
  }
}
