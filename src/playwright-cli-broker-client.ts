import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const DEFAULT_BROKER_PATH = fileURLToPath(
  new URL("./playwright-cli-broker.ts", import.meta.url),
);

export type PlaywrightCliBrokerErrorCode =
  | "broker_unavailable"
  | "broker_spawn_failed"
  | "broker_timeout"
  | "broker_output_limit"
  | "broker_protocol_error";

export class PlaywrightCliBrokerError extends Error {
  constructor(
    readonly code: PlaywrightCliBrokerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PlaywrightCliBrokerResponse {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly message?: string;
}

interface Pending {
  readonly resolve: (
    response: PlaywrightCliBrokerResponse,
  ) => void;
  readonly reject: (
    error: PlaywrightCliBrokerError,
  ) => void;
  readonly timer: NodeJS.Timeout;
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
  #buffer = "";
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
  ): Promise<PlaywrightCliBrokerResponse> {
    if (this.#disabled || this.#closing) {
      throw new PlaywrightCliBrokerError(
        "broker_unavailable",
        "Playwright CLI broker is unavailable.",
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

        this.#pending.set(id, {
          resolve: resolvePromise,
          reject,
          timer,
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

    this.#buffer = "";
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
      this.#buffer += chunk;

      if (
        Buffer.byteLength(this.#buffer, "utf8") >
        MAX_OUTPUT_BYTES
      ) {
        this.#fail(
          new PlaywrightCliBrokerError(
            "broker_output_limit",
            `Playwright CLI broker output exceeded ${MAX_OUTPUT_BYTES} bytes.`,
          ),
          !this.#ready,
        );
        return;
      }

      this.#drain();
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

  #drain(): void {
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;

      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        this.#fail(
          new PlaywrightCliBrokerError(
            "broker_protocol_error",
            "Playwright CLI broker returned invalid JSON.",
          ),
          !this.#ready,
        );
        return;
      }

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { id?: unknown }).id !== "number" ||
        typeof (parsed as { exitCode?: unknown }).exitCode !==
          "number" ||
        typeof (parsed as { stdout?: unknown }).stdout !==
          "string" ||
        typeof (parsed as { stderr?: unknown }).stderr !==
          "string"
      ) {
        this.#fail(
          new PlaywrightCliBrokerError(
            "broker_protocol_error",
            "Playwright CLI broker returned an invalid response.",
          ),
          !this.#ready,
        );
        return;
      }

      const response = parsed as {
        id: number;
        exitCode: number;
        stdout: string;
        stderr: string;
        message?: string;
      };
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
        continue;
      }

      this.#pending.delete(response.id);
      clearTimeout(pending.timer);
      pending.resolve({
        exitCode: response.exitCode,
        stdout: response.stdout,
        stderr: response.stderr,
        ...(response.message === undefined
          ? {}
          : { message: response.message }),
      });
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
      child.kill();
    }
  }

  #rejectAll(
    error: PlaywrightCliBrokerError,
  ): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
