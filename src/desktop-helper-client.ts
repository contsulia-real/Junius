import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export type DesktopHelperClientErrorCode =
  | "spawn_failed"
  | "process_timeout"
  | "output_limit"
  | "helper_failed"
  | "invalid_helper_response";

export class DesktopHelperClientError extends Error {
  constructor(
    readonly code: DesktopHelperClientErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface DesktopHelperResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly code?: string;
  readonly message?: string;
}

interface PendingRequest {
  readonly resolve: (response: DesktopHelperResponse) => void;
  readonly reject: (error: DesktopHelperClientError) => void;
  readonly timer: NodeJS.Timeout;
}

export interface DesktopHelperClientOptions {
  readonly pythonExecutable: string;
  readonly helperPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

function boundedAppend(
  current: string,
  chunk: Buffer | string,
): string {
  const next = current + chunk.toString();
  return next.length <= MAX_STDERR_BYTES
    ? next
    : next.slice(next.length - MAX_STDERR_BYTES);
}

export class DesktopHelperClient {
  readonly #pythonExecutable: string;
  readonly #helperPath: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #timeoutMs: number;

  #child: ChildProcessWithoutNullStreams | undefined;
  #stdoutDecoder = new StringDecoder("utf8");
  #stdoutBuffer = "";
  #stderr = "";
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #closing = false;

  constructor(options: DesktopHelperClientOptions) {
    this.#pythonExecutable = options.pythonExecutable;
    this.#helperPath = options.helperPath;
    this.#environment = options.environment;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get running(): boolean {
    return (
      this.#child !== undefined &&
      this.#child.exitCode === null &&
      this.#child.signalCode === null
    );
  }

  request(
    request: Record<string, unknown>,
  ): Promise<DesktopHelperResponse> {
    if (this.#closing) {
      return Promise.reject(
        new DesktopHelperClientError(
          "helper_failed",
          "Desktop helper client is closing.",
        ),
      );
    }

    const child = this.#ensureChild();
    const id = this.#nextId++;
    const payload =
      JSON.stringify({
        id,
        request,
      }) + "\n";

    return new Promise<DesktopHelperResponse>(
      (resolvePromise, reject) => {
        const timer = setTimeout(() => {
          this.#terminateWithError(
            new DesktopHelperClientError(
              "process_timeout",
              `Desktop helper request exceeded ${this.#timeoutMs} ms.`,
            ),
          );
        }, this.#timeoutMs);

        this.#pending.set(id, {
          resolve: resolvePromise,
          reject,
          timer,
        });

        child.stdin.write(payload, "utf8", (error) => {
          if (error === null || error === undefined) {
            return;
          }

          this.#terminateWithError(
            new DesktopHelperClientError(
              "helper_failed",
              error.message,
            ),
          );
        });
      },
    );
  }

  async close(): Promise<void> {
    this.#closing = true;

    const child = this.#child;
    this.#child = undefined;

    const error = new DesktopHelperClientError(
      "helper_failed",
      "Desktop helper client closed.",
    );
    this.#rejectAll(error);

    if (
      child === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }

    child.stdin.end();

    const exited = await Promise.race([
      once(child, "close").then(() => true),
      new Promise<boolean>((resolvePromise) =>
        setTimeout(() => resolvePromise(false), 1_000),
      ),
    ]);

    if (!exited) {
      child.kill();
      await Promise.race([
        once(child, "close"),
        new Promise((resolvePromise) =>
          setTimeout(resolvePromise, 1_000),
        ),
      ]);
    }
  }

  #ensureChild(): ChildProcessWithoutNullStreams {
    if (this.running) {
      return this.#child!;
    }

    this.#stdoutDecoder = new StringDecoder("utf8");
    this.#stdoutBuffer = "";
    this.#stderr = "";

    const child = spawn(
      this.#pythonExecutable,
      [this.#helperPath, "--server"],
      {
        env: this.#environment,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    this.#child = child;

    child.stdout.on("data", (chunk: Buffer | string) => {
      this.#handleStdout(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderr = boundedAppend(this.#stderr, chunk);
    });

    child.once("error", (error) => {
      if (this.#child !== child) return;

      this.#terminateWithError(
        new DesktopHelperClientError(
          "spawn_failed",
          error.message,
        ),
      );
    });

    child.once("close", (exitCode, signal) => {
      if (this.#child !== child) return;

      this.#child = undefined;
      const tail = this.#stdoutDecoder.end();
      if (tail) {
        this.#stdoutBuffer += tail;
      }

      if (this.#pending.size === 0) {
        return;
      }

      this.#rejectAll(
        new DesktopHelperClientError(
          "helper_failed",
          this.#stderr ||
            `Desktop helper server exited with code ${String(exitCode)} signal ${String(signal)}.`,
        ),
      );
    });

    return child;
  }

  #handleStdout(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    this.#stdoutBuffer += this.#stdoutDecoder.write(buffer);

    if (
      Buffer.byteLength(this.#stdoutBuffer, "utf8") >
      MAX_OUTPUT_BYTES
    ) {
      this.#terminateWithError(
        new DesktopHelperClientError(
          "output_limit",
          `Desktop helper response exceeded ${MAX_OUTPUT_BYTES} bytes.`,
        ),
      );
      return;
    }

    for (;;) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) break;

      const line = this.#stdoutBuffer.slice(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);

      if (!line.trim()) continue;
      this.#handleLine(line);
    }
  }

  #handleLine(line: string): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.#terminateWithError(
        new DesktopHelperClientError(
          "invalid_helper_response",
          "Desktop helper server returned invalid JSON.",
        ),
      );
      return;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("id" in parsed) ||
      typeof (parsed as { id?: unknown }).id !== "number" ||
      !("ok" in parsed) ||
      typeof (parsed as { ok?: unknown }).ok !== "boolean"
    ) {
      this.#terminateWithError(
        new DesktopHelperClientError(
          "invalid_helper_response",
          "Desktop helper server returned an invalid response object.",
        ),
      );
      return;
    }

    const record = parsed as {
      id: number;
      ok: boolean;
      result?: unknown;
      code?: string;
      message?: string;
    };
    const pending = this.#pending.get(record.id);

    if (pending === undefined) {
      return;
    }

    this.#pending.delete(record.id);
    clearTimeout(pending.timer);
    pending.resolve({
      ok: record.ok,
      ...(record.result === undefined
        ? {}
        : { result: record.result }),
      ...(record.code === undefined
        ? {}
        : { code: record.code }),
      ...(record.message === undefined
        ? {}
        : { message: record.message }),
    });
  }

  #terminateWithError(
    error: DesktopHelperClientError,
  ): void {
    const child = this.#child;
    this.#child = undefined;

    this.#rejectAll(error);

    if (
      child !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      child.kill();
    }
  }

  #rejectAll(error: DesktopHelperClientError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
