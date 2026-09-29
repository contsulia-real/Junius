import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { terminateProcessTree } from "./process-termination.js";
import {
  DesktopHelperClientError,
  DesktopHelperProtocolDecoder,
  desktopHelperResponse,
  isDesktopHelperReady,
  type DesktopHelperClientErrorCode,
  type DesktopHelperResponse,
} from "./desktop-helper-protocol.js";

export {
  DesktopHelperClientError,
  type DesktopHelperClientErrorCode,
  type DesktopHelperResponse,
} from "./desktop-helper-protocol.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STDERR_BYTES = 64 * 1024;

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
  readonly #protocol = new DesktopHelperProtocolDecoder();
  #stderr = "";
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #ready = false;
  #readyPromise: Promise<void> | undefined;
  #readyResolve: (() => void) | undefined;
  #readyReject:
    | ((error: DesktopHelperClientError) => void)
    | undefined;
  #readyTimer: NodeJS.Timeout | undefined;
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

  get ready(): boolean {
    return this.#ready;
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
    this.#rejectReady(error);
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
      await terminateProcessTree(
        child,
        this.#environment,
      );
    }
  }

  #ensureChild(): ChildProcessWithoutNullStreams {
    if (this.running) {
      return this.#child!;
    }

    this.#protocol.reset();
    this.#stderr = "";
    this.#ready = false;
    this.#readyPromise = new Promise<void>(
      (resolvePromise, reject) => {
        this.#readyResolve = resolvePromise;
        this.#readyReject = reject;
      },
    );
    void this.#readyPromise.catch(() => {});
    this.#readyTimer = setTimeout(() => {
      this.#terminateWithError(
        new DesktopHelperClientError(
          "process_timeout",
          `Desktop helper did not become ready within ${this.#timeoutMs} ms.`,
        ),
      );
    }, this.#timeoutMs);

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
      this.#protocol.finish();

      if (
        this.#pending.size === 0 &&
        this.#ready
      ) {
        return;
      }

      const error = new DesktopHelperClientError(
        "helper_failed",
        this.#stderr ||
          `Desktop helper server exited with code ${String(exitCode)} signal ${String(signal)}.`,
      );
      this.#rejectReady(error);
      this.#rejectAll(error);
    });

    return child;
  }

  #handleStdout(chunk: Buffer | string): void {
    let records;
    try {
      records = this.#protocol.push(chunk);
    } catch (error) {
      this.#terminateWithError(
        error instanceof DesktopHelperClientError
          ? error
          : new DesktopHelperClientError(
              "invalid_helper_response",
              error instanceof Error
                ? error.message
                : String(error),
            ),
      );
      return;
    }

    for (const record of records) {
      const pending = this.#pending.get(record.id);

      if (pending === undefined) {
        if (isDesktopHelperReady(record)) {
          this.#markReady();
        }
        continue;
      }

      this.#pending.delete(record.id);
      clearTimeout(pending.timer);
      pending.resolve(desktopHelperResponse(record));
    }
  }

  #markReady(): void {
    if (this.#ready) return;

    this.#ready = true;
    if (this.#readyTimer !== undefined) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = undefined;
    }
    this.#readyResolve?.();
    this.#readyResolve = undefined;
    this.#readyReject = undefined;
  }

  #rejectReady(error: DesktopHelperClientError): void {
    if (this.#readyTimer !== undefined) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = undefined;
    }
    this.#readyReject?.(error);
    this.#readyResolve = undefined;
    this.#readyReject = undefined;
    this.#readyPromise = undefined;
    this.#ready = false;
  }

  #terminateWithError(
    error: DesktopHelperClientError,
  ): void {
    const child = this.#child;
    this.#child = undefined;

    this.#rejectReady(error);
    this.#rejectAll(error);

    if (
      child !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      void terminateProcessTree(
        child,
        this.#environment,
      );
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
