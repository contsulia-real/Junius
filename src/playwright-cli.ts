import { mkdir } from "node:fs/promises";
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
  PLAYWRIGHT_CLI_COMMANDS,
  playwrightCliCommandArgs,
  validatePlaywrightCliArgs,
  type PlaywrightCliCommand,
} from "./playwright-cli-policy.js";
import {
  PlaywrightSessionPool,
  type PlaywrightSessionToken,
} from "./playwright-session-pool.js";
import { runPlaywrightCliSpawn } from "./playwright-cli-spawn-executor.js";
import {
  PlaywrightCliError,
  type PlaywrightCliExecution,
  type PlaywrightCliServiceOptions,
} from "./playwright-cli-types.js";

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

  async prewarm(): Promise<void> {
    if (
      !this.available ||
      this.#broker?.available !== true
    ) {
      return;
    }

    await mkdir(this.#statePath, { recursive: true });

    try {
      await this.#broker.prewarm();
      this.#brokerError = undefined;
    } catch (error) {
      if (error instanceof PlaywrightCliBrokerError) {
        this.#brokerError = `${error.code}: ${error.message}`;
        return;
      }
      throw error;
    }
  }

  async run(
    session: string,
    command: PlaywrightCliCommand,
    args: readonly string[],
  ): Promise<PlaywrightCliExecution> {
    if (!SESSION_PATTERN.test(session)) {
      throw new PlaywrightCliError(
        "invalid_session",
        `Invalid playwright-cli session name: ${session}`,
      );
    }

    if (!(PLAYWRIGHT_CLI_COMMANDS as readonly string[]).includes(command)) {
      throw new PlaywrightCliError(
        "command_not_allowed",
        `playwright-cli command is not allowed: ${command}`,
      );
    }

    if (!validatePlaywrightCliArgs(command, args)) {
      throw new PlaywrightCliError(
        "arguments_not_allowed",
        `Arguments are not allowed for playwright-cli command ${command}.`,
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

    const launcher = this.#launcher;
    const closingState: PlaywrightSessionToken | undefined =
      command === "close"
        ? this.#sessions.prepareClose(session)
        : undefined;

    if (command !== "close") {
      this.#sessions.beginActivity(session);
    }

    try {
      await mkdir(this.#statePath, { recursive: true });

    const startedAt = performance.now();
    const cliArgs = playwrightCliCommandArgs(session, command, args);

    if (this.#broker?.available === true) {
      try {
        const response = await this.#broker.run(
          cliArgs,
          this.#statePath,
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
        if (command === "close") {
          this.#sessions.completeClose(session);
        }

        return {
          session,
          command,
          exitCode: 0,
          stdout: response.stdout,
          stderr: response.stderr,
          durationMs: Math.round(performance.now() - startedAt),
          transport: "broker",
        };
      } catch (error) {
        if (!(error instanceof PlaywrightCliBrokerError)) {
          throw error;
        }
        this.#brokerError = `${error.code}: ${error.message}`;
      }
    }

    const execution = await runPlaywrightCliSpawn({
      launcher,
      cliArgs,
      cwd: this.#statePath,
      environment: this.#environment,
      session,
      command,
      startedAt,
    });

    if (command === "close") {
      this.#sessions.completeClose(session);
    }

    return execution;
    } finally {
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
  PLAYWRIGHT_CLI_COMMANDS,
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
