import {
  mkdir,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import {
  PlaywrightCliBrokerClient,
  PlaywrightCliBrokerError,
} from "./playwright-cli-broker-client.js";
import { resolveNodeExecutable } from "./node-executable.js";
import { withoutEnvironmentVariables } from "./execution-environment.js";
import {
  resolveBrowserStatePath,
  resolvePlaywrightCliLauncher,
  supportsPersistentBroker,
  type PlaywrightCliLauncher,
} from "./playwright-cli-launcher.js";
import {
  PlaywrightSessionPool,
  type PlaywrightSessionToken,
} from "./playwright-session-pool.js";
import { runPlaywrightCliSpawn } from "./playwright-cli-spawn-executor.js";
import {
  PlaywrightCliError,
  type PlaywrightCliCommand,
  type PlaywrightCliExecution,
  type PlaywrightCliServiceOptions,
} from "./playwright-cli-types.js";
import type {
  UserInterruptLease,
  UserInterruptSource,
} from "./user-interrupt.js";

const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_SESSION_IDLE_MS = 10 * 60_000;
const DEFAULT_MAX_SESSIONS = 32;

function positiveIntegerOr(
  value: number | undefined,
  fallback: number,
): number {
  if (
    value === undefined ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

export class PlaywrightCliService {
  readonly #launcher: PlaywrightCliLauncher | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #statePath: string;
  readonly #broker: PlaywrightCliBrokerClient | undefined;
  readonly #sessions: PlaywrightSessionPool;
  readonly #retainData: boolean;
  readonly #interrupt:
    UserInterruptSource | undefined;
#brokerError: string | undefined;
  #closing = false;

  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    nodeExecutable = resolveNodeExecutable(environment),
    options: PlaywrightCliServiceOptions = {},
  ) {
    this.#environment = withoutEnvironmentVariables(
      environment,
      {
        names: ["NODE_OPTIONS", "NODE_PATH"],
      },
    );
    const environmentSessionIdleMs = Number(
      environment.JUNIUS_BROWSER_SESSION_IDLE_MS,
    );
    const sessionIdleMs = positiveIntegerOr(
      options.sessionIdleMs,
      positiveIntegerOr(
        environmentSessionIdleMs,
        DEFAULT_SESSION_IDLE_MS,
      ),
    );
    const maxSessions = positiveIntegerOr(
      options.maxSessions,
      DEFAULT_MAX_SESSIONS,
    );
    this.#retainData =
      options.retainData ??
      environment
        .JUNIUS_BROWSER_RETAIN_DATA ===
        "1";
    this.#interrupt =
      options.interrupt;
    this.#sessions = new PlaywrightSessionPool({
      idleMs: sessionIdleMs,
      maxSessions,
      closeSession: (session) =>
        this.run(session, "close", []).then(() => undefined),
      isClosing: () => this.#closing,
    });
    this.#statePath = resolveBrowserStatePath(environment);
    this.#launcher = resolvePlaywrightCliLauncher(
      environment,
      nodeExecutable,
    );
    this.#broker =
      nodeExecutable !== undefined &&
      supportsPersistentBroker(this.#launcher?.entryPath)
        ? new PlaywrightCliBrokerClient({
            cliEntryPath: this.#launcher.entryPath,
            environment: this.#environment,
            nodeExecutable,
          })
        : undefined;
  }

  get available(): boolean {
    return this.#launcher !== undefined;
  }

  state(): {
    readonly available: boolean;
    readonly statePath: string;
    readonly transport: "broker" | "spawn";
    readonly brokerRunning: boolean;
    readonly brokerReady: boolean;
    readonly brokerError?: string;
    readonly sessionCount: number;
    readonly sessionIdleMs: number;
    readonly maxSessions: number;
    readonly retainData: boolean;
    readonly sessionCleanupError?: string;
    readonly launcher?: {
      readonly executable: string;
      readonly fixedArgs: readonly string[];
      readonly entryPath?: string;
    };
  } {
    return {
      available: this.available,
      statePath: this.#statePath,
      transport:
        this.#broker?.available === true
          ? "broker"
          : "spawn",
      brokerRunning: this.#broker?.running ?? false,
      brokerReady: this.#broker?.ready ?? false,
      sessionCount: this.#sessions.count,
      sessionIdleMs: this.#sessions.idleMs,
      maxSessions: this.#sessions.maxSessions,
      retainData:
        this.#retainData,
      ...(this.#brokerError === undefined
        ? {}
        : { brokerError: this.#brokerError }),
      ...(this.#sessions.cleanupError === undefined
        ? {}
        : {
            sessionCleanupError:
              this.#sessions.cleanupError,
          }),
      ...(this.#launcher === undefined
        ? {}
        : {
            launcher: {
              executable: this.#launcher.executable,
              fixedArgs: this.#launcher.fixedArgs,
              ...(this.#launcher.entryPath === undefined
                ? {}
                : { entryPath: this.#launcher.entryPath }),
            },
          }),
    };
  }


  async run(
    session: string,
    command: PlaywrightCliCommand,
    args: readonly string[]
  ): Promise<PlaywrightCliExecution> {
    if (!SESSION_PATTERN.test(session)) {
      throw new PlaywrightCliError(
        "invalid_session",
        `Invalid playwright-cli session name: ${session}`,
      );
    }

    if (this.#closing && command !== "close") {
      throw new PlaywrightCliError(
        "playwright_cli_closing",
        "Browser computer use is shutting down.",
      );
    }

    if (this.#launcher === undefined) {
      throw new PlaywrightCliError(
        "playwright_cli_not_available",
        "playwright-cli was not found on PATH.",
      );
    }

    const closingState: PlaywrightSessionToken | undefined =
      command === "close"
        ? this.#sessions.prepareClose(session)
        : undefined;

    if (command === "close") {
      this.#sessions.completeClose(session);
    } else {
      this.#sessions.beginActivity(session);
    }

    const sessionPath = join(
      this.#statePath,
      session,
    );
    let interruptLease:
      UserInterruptLease | undefined;

    try {
      interruptLease =
        command === "close"
          ? undefined
          : await this.#interrupt?.arm();
      await mkdir(sessionPath, { recursive: true });

      if (command === "close") {
        let execution:
          PlaywrightCliExecution | undefined;
        let closeError: unknown;

        try {
          execution = await this.#executeCli(
            session,
            command,
            args,
            sessionPath,
            undefined,
          );
        } catch (error) {
          closeError = error;
        }

        let cleanupError: unknown;
        if (!this.#retainData) {
          try {
            await this.#cleanupSessionData(
              session,
              sessionPath,
            );
          } catch (error) {
            cleanupError = error;
          }
        }

        if (closeError !== undefined) {
          throw closeError;
        }
        if (cleanupError !== undefined) {
          throw new PlaywrightCliError(
            "data_cleanup_failed",
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
          );
        }

        return execution!;
      }

      const execution = await this.#executeCli(
        session,
        command,
        args,
        sessionPath,
        interruptLease?.signal,
      );

      return execution;
    } finally {
      interruptLease?.release();
      if (command === "close") {
        this.#sessions.restoreAfterClose(
          session,
          closingState,
        );
      } else {
        this.#sessions.endActivity(
          session,
          true,
        );
      }
    }
  }

  async #executeCli(
    session: string,
    command: PlaywrightCliCommand,
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<PlaywrightCliExecution> {
    const launcher = this.#launcher!;
    const startedAt = performance.now();
    const cliArgs = [
      `-s=${session}`,
      command,
      ...args,
    ];

    if (this.#broker?.available === true) {
      try {
        const response = await this.#broker.run(
          cliArgs,
          cwd,
          signal,
        );

        if (response.exitCode !== 0) {
          throw new PlaywrightCliError(
            "nonzero_exit",
            response.stderr ||
              response.stdout ||
              response.message ||
              `playwright-cli exited with code ${String(response.exitCode)}.`,
          );
        }

        this.#brokerError = undefined;
        return {
          session,
          command,
          exitCode: 0,
          stdout: response.stdout,
          stderr: response.stderr,
          durationMs: Math.round(
            performance.now() - startedAt,
          ),
          transport: "broker",
        };
      } catch (error) {
        if (!(error instanceof PlaywrightCliBrokerError)) {
          throw error;
        }
        if (
          error.code ===
            "broker_interrupted" ||
          signal?.aborted === true
        ) {
          throw new PlaywrightCliError(
            "user_interrupted",
            "Browser operation interrupted by user pressing Escape.",
          );
        }
        this.#brokerError = `${error.code}: ${error.message}`;
      }
    }

    return await runPlaywrightCliSpawn({
      launcher,
      cliArgs,
      cwd,
      environment: this.#environment,
      session,
      command,
      startedAt,
      ...(signal === undefined
        ? {}
        : { signal }),
    });
  }

  async #cleanupSessionData(
    session: string,
    sessionPath: string,
  ): Promise<void> {
    let deleteError: unknown;
    try {
      await this.#executeCli(
        session,
        "delete-data",
        [],
        sessionPath,
      );
    } catch (error) {
      deleteError = error;
    }

    let removeError: unknown;
    try {
      await rm(
        sessionPath,
        {
          recursive: true,
          force: true,
        },
      );
    } catch (error) {
      removeError = error;
    }

    if (
      deleteError !== undefined ||
      removeError !== undefined
    ) {
      const messages: string[] = [];
      if (deleteError !== undefined) {
        messages.push(
          `playwright delete-data failed: ${
            deleteError instanceof Error
              ? deleteError.message
              : String(deleteError)
          }`,
        );
      }
      if (removeError !== undefined) {
        messages.push(
          `managed browser data removal failed: ${
            removeError instanceof Error
              ? removeError.message
              : String(removeError)
          }`,
        );
      }
      throw new Error(messages.join("; "));
    }
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;

    const sessions =
      await this.#sessions.beginShutdown();
    await Promise.allSettled(
      sessions.map((session) =>
        this.run(session, "close", []),
      ),
    );

    this.#sessions.clear();

    await this.#broker?.close();
  }
}


export {
  PlaywrightCliError,
  resolveBrowserStatePath,
  resolvePlaywrightCliLauncher,
};
export type {
  PlaywrightCliCommand,
  PlaywrightCliExecution,
  PlaywrightCliServiceOptions,
};
export type {
  PlaywrightCliErrorCode,
} from "./playwright-cli-types.js";
