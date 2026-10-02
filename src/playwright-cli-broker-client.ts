import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { terminateProcessTree } from "./process-termination.js";
import {
  PlaywrightCliBrokerError,
  PlaywrightCliBrokerProtocolDecoder,
  playwrightCliBrokerResponse,
  type PlaywrightCliBrokerEnvelope,
  type PlaywrightCliBrokerErrorCode,
  type PlaywrightCliBrokerResponse,
} from "./playwright-cli-broker-protocol.js";

export {
  PlaywrightCliBrokerError,
  type PlaywrightCliBrokerErrorCode,
  type PlaywrightCliBrokerResponse,
} from "./playwright-cli-broker-protocol.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const BROKER_SOURCE_EXTENSION =
  import.meta.url.endsWith(".js")
    ? ".js"
    : ".ts";
const DEFAULT_BROKER_PATH = fileURLToPath(
  new URL(
    `./playwright-cli-broker${BROKER_SOURCE_EXTENSION}`,
    import.meta.url,
  ),
);

interface Pending {
  readonly resolve: (
    response: PlaywrightCliBrokerResponse,
  ) => void;
  readonly reject: (
    error: PlaywrightCliBrokerError,
  ) => void;
  readonly timer: NodeJS.Timeout;
  readonly cleanupAbort?: () => void;
}

export interface PlaywrightCliBrokerClientOptions {
  readonly cliEntryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly nodeExecutable: string;
  readonly brokerPath?: string;
  readonly timeoutMs?: number;
}

export class PlaywrightCliBrokerClient {
  readonly #cliEntryPath: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #nodeExecutable: string;
  readonly #brokerPath: string;
  readonly #timeoutMs: number;

  #child: ChildProcessWithoutNullStreams | undefined;
  readonly #protocol =
    new PlaywrightCliBrokerProtocolDecoder();
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #ready = false;
  #readyPromise: Promise<void> | undefined;
  #readyResolve: (() => void) | undefined;
  #readyReject:
    | ((error: PlaywrightCliBrokerError) => void)
    | undefined;
  #readyTimer: NodeJS.Timeout | undefined;
  #disabled = false;
  #closing = false;

  constructor(options: PlaywrightCliBrokerClientOptions) {
    this.#cliEntryPath = options.cliEntryPath;
    this.#environment = options.environment;
    this.#nodeExecutable = options.nodeExecutable;
    this.#brokerPath =
      options.brokerPath ?? DEFAULT_BROKER_PATH;
    this.#timeoutMs =
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get running(): boolean {
    return (
      this.#child !== undefined &&
      this.#child.exitCode === null &&
      this.#child.signalCode === null
    );
  }

  get available(): boolean {
    return !this.#disabled;
  }

  get ready(): boolean {
    return this.#ready;
  }

  async prewarm(): Promise<void> {
    if (this.#disabled || this.#closing) {
      throw new PlaywrightCliBrokerError(
        "broker_unavailable",
        "Playwright CLI broker is unavailable.",
      );
    }

    this.#ensureChild();
    await this.#readyPromise;
  }

  async run(
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<PlaywrightCliBrokerResponse> {
    if (this.#disabled || this.#closing) {
      throw new PlaywrightCliBrokerError(
        "broker_unavailable",
        "Playwright CLI broker is unavailable.",
      );
    }

    if (signal?.aborted) {
      throw new PlaywrightCliBrokerError(
        "broker_interrupted",
        "Browser operation interrupted by user pressing Escape.",
      );
    }

    const child = this.#ensureChild();
    const id = this.#nextId++;
    const payload =
      JSON.stringify({
        id,
        args,
        cwd,
      }) + "\n";

    return new Promise<PlaywrightCliBrokerResponse>(
      (resolvePromise, reject) => {
        const timer = setTimeout(() => {
          this.#fail(
            new PlaywrightCliBrokerError(
              "broker_timeout",
              `Playwright CLI broker exceeded ${this.#timeoutMs} ms.`,
            ),
            false,
          );
        }, this.#timeoutMs);

        let cleanupAbort:
          (() => void) | undefined;
        if (signal !== undefined) {
          const onAbort = () => {
            this.#fail(
              new PlaywrightCliBrokerError(
                "broker_interrupted",
                "Browser operation interrupted by user pressing Escape.",
              ),
              false,
            );
          };
          signal.addEventListener(
            "abort",
            onAbort,
            { once: true },
          );
          cleanupAbort = () =>
            signal.removeEventListener(
              "abort",
              onAbort,
            );
        }

        this.#pending.set(id, {
          resolve: resolvePromise,
          reject,
          timer,
          ...(cleanupAbort === undefined
            ? {}
            : { cleanupAbort }),
        });

        child.stdin.write(payload, "utf8", (error) => {
          if (error === null || error === undefined) {
            return;
          }

          this.#fail(
            new PlaywrightCliBrokerError(
              "broker_protocol_error",
              error.message,
            ),
            false,
          );
        });
      },
    );
  }

  async close(): Promise<void> {
    this.#closing = true;
    const child = this.#child;
    this.#child = undefined;

    const closingError = new PlaywrightCliBrokerError(
      "broker_unavailable",
      "Playwright CLI broker closed.",
    );
    this.#rejectReady(closingError);
    this.#rejectAll(closingError);

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
    this.#ready = false;
    this.#readyPromise = new Promise<void>(
      (resolvePromise, reject) => {
        this.#readyResolve = resolvePromise;
        this.#readyReject = reject;
      },
    );
    void this.#readyPromise.catch(() => {});
    this.#readyTimer = setTimeout(() => {
      this.#fail(
        new PlaywrightCliBrokerError(
          "broker_timeout",
          `Playwright CLI broker did not become ready within ${this.#timeoutMs} ms.`,
        ),
        true,
      );
    }, this.#timeoutMs);

    const child = spawn(
      this.#nodeExecutable,
      [
        "--no-warnings",
        this.#brokerPath,
      ],
      {
        env: {
          ...this.#environment,
          JUNIUS_PLAYWRIGHT_CLI_ENTRY:
            this.#cliEntryPath,
        },
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    this.#child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      let records: readonly PlaywrightCliBrokerEnvelope[];
      try {
        records = this.#protocol.push(chunk);
      } catch (error) {
        this.#fail(
          error instanceof PlaywrightCliBrokerError
            ? error
            : new PlaywrightCliBrokerError(
                "broker_protocol_error",
                error instanceof Error
                  ? error.message
                  : String(error),
              ),
          !this.#ready,
        );
        return;
      }

      for (const record of records) {
        this.#handleResponse(record);
      }
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) {
        stderr = stderr.slice(-64 * 1024);
      }
    });

    child.once("error", (error) => {
      if (this.#child !== child) return;
      this.#fail(
        new PlaywrightCliBrokerError(
          "broker_spawn_failed",
          error.message,
        ),
        !this.#ready,
      );
    });

    child.once("close", (exitCode, signal) => {
      if (this.#child !== child) return;
      this.#child = undefined;

      if (
        this.#pending.size === 0 &&
        this.#ready
      ) {
        return;
      }

      this.#fail(
        new PlaywrightCliBrokerError(
          "broker_unavailable",
          stderr ||
            `Playwright CLI broker exited with code ${String(exitCode)} signal ${String(signal)}.`,
        ),
        !this.#ready,
      );
    });

    return child;
  }

  #handleResponse(
    response: PlaywrightCliBrokerEnvelope,
  ): void {
    const pending = this.#pending.get(response.id);

    if (pending === undefined) {
      if (response.id === 0) {
        if (response.exitCode === 0) {
          this.#markReady();
        } else {
          this.#fail(
            new PlaywrightCliBrokerError(
              "broker_unavailable",
              response.message ||
                response.stderr ||
                "Playwright CLI broker failed to initialize.",
            ),
            true,
          );
        }
      }
      return;
    }

    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.cleanupAbort?.();
    pending.resolve(
      playwrightCliBrokerResponse(response),
    );
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

  #rejectReady(error: PlaywrightCliBrokerError): void {
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

  #fail(
    error: PlaywrightCliBrokerError,
    disable: boolean,
  ): void {
    const child = this.#child;
    this.#child = undefined;

    if (disable) {
      this.#disabled = true;
    }

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

  #rejectAll(
    error: PlaywrightCliBrokerError,
  ): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanupAbort?.();
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
