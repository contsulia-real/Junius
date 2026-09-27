import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  PlaywrightCliBrokerClient,
  PlaywrightCliBrokerError,
} from "./playwright-cli-broker-client.js";
import { resolveNodeExecutable } from "./capabilities/node-capability.js";
import { withoutEnvironmentVariables } from "./execution-environment.js";
import { terminateProcessTree } from "./process-termination.js";
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
  PlaywrightCliError,
  type PlaywrightCliErrorCode,
  type PlaywrightCliExecution,
  type PlaywrightCliServiceOptions,
} from "./playwright-cli-types.js";

const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
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

interface BrowserSessionState {
  lastUsedAt: number;
  inFlight: number;
  timer?: NodeJS.Timeout;
}

export class PlaywrightCliService {
  readonly #launcher: PlaywrightCliLauncher | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #statePath: string;
  readonly #broker: PlaywrightCliBrokerClient | undefined;
  readonly #sessions = new Map<string, BrowserSessionState>();
  readonly #pendingSessionCleanup = new Set<Promise<void>>();
  readonly #sessionIdleMs: number;
  readonly #maxSessions: number;
  #brokerError: string | undefined;
  #sessionCleanupError: string | undefined;
  #closing = false;
  #enabled = true;

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
    this.#sessionIdleMs = positiveIntegerOr(
      options.sessionIdleMs,
      positiveIntegerOr(
        environmentSessionIdleMs,
        DEFAULT_SESSION_IDLE_MS,
      ),
    );
    this.#maxSessions = positiveIntegerOr(
      options.maxSessions,
      DEFAULT_MAX_SESSIONS,
    );
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

  get enabled(): boolean {
    return this.#enabled;
  }

  get available(): boolean {
    return this.#launcher !== undefined;
  }

  get active(): boolean {
    return this.#enabled && this.available;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (this.#enabled === enabled) return;

    this.#enabled = enabled;

    if (enabled) {
      return;
    }

    for (const [session, state] of [
      ...this.#sessions.entries(),
    ]) {
      if (state.inFlight === 0) {
        this.#startSessionCleanup(session, state);
      }
    }

    await Promise.allSettled([
      ...this.#pendingSessionCleanup,
    ]);
  }

  state(): {
    readonly enabled: boolean;
    readonly available: boolean;
    readonly active: boolean;
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
      enabled: this.enabled,
      available: this.available,
      active: this.active,
      statePath: this.#statePath,
      transport:
        this.#broker?.available === true
          ? "broker"
          : "spawn",
      brokerRunning: this.#broker?.running ?? false,
      brokerReady: this.#broker?.ready ?? false,
      sessionCount: this.#sessions.size,
      sessionIdleMs: this.#sessionIdleMs,
      maxSessions: this.#maxSessions,
      ...(this.#brokerError === undefined
        ? {}
        : { brokerError: this.#brokerError }),
      ...(this.#sessionCleanupError === undefined
        ? {}
        : {
            sessionCleanupError:
              this.#sessionCleanupError,
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
      !this.active ||
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
        "playwright_cli_disabled",
        "Browser computer use is shutting down.",
      );
    }

    if (!this.#enabled && command !== "close") {
      throw new PlaywrightCliError(
        "playwright_cli_disabled",
        "Browser computer use is disabled by the Junius machine capability policy.",
      );
    }

    if (this.#launcher === undefined) {
      throw new PlaywrightCliError(
        "playwright_cli_not_available",
        "playwright-cli was not found on PATH.",
      );
    }

    const launcher = this.#launcher;
    const closingState =
      command === "close"
        ? this.#sessions.get(session)
        : undefined;

    if (command === "close") {
      if (closingState?.timer !== undefined) {
        clearTimeout(closingState.timer);
        closingState.timer = undefined;
      }
    } else {
      this.#beginSessionActivity(session);
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
          this.#forgetSession(session);
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

    return await new Promise<PlaywrightCliExecution>((resolvePromise, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let timedOut = false;
      let outputLimit = false;

      const child = spawn(
        launcher.executable,
        [
          ...launcher.fixedArgs,
          ...cliArgs,
        ],
        {
          cwd: this.#statePath,
          env: this.#environment,
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
              this.#environment,
            );
          }
          return;
        }

        target.push(buffer);
      };

      child.stdout.on("data", (chunk: Buffer | string) => {
        append(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        append(stderr, chunk);
      });

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

        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");

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
        if (command === "close") {
          this.#forgetSession(session);
        }
        resolvePromise({
          session,
          command,
          exitCode: 0,
          stdout: stdoutText,
          stderr: stderrText,
          durationMs: Math.round(performance.now() - startedAt),
          transport: "spawn",
        });
      });

      const timer = setTimeout(() => {
        timedOut = true;
        void terminateProcessTree(
          child,
          this.#environment,
        );
      }, DEFAULT_TIMEOUT_MS);
    });
    } finally {
      if (command === "close") {
        const state = this.#sessions.get(session);
        if (
          !this.#closing &&
          state !== undefined &&
          state === closingState &&
          state.inFlight === 0 &&
          state.timer === undefined
        ) {
          this.#armSessionTimer(session, state);
        }
      } else {
        this.#endSessionActivity(session);
      }
    }
  }

  #forgetSession(session: string): void {
    const state = this.#sessions.get(session);
    if (state?.timer !== undefined) {
      clearTimeout(state.timer);
    }
    this.#sessions.delete(session);
  }

  #beginSessionActivity(session: string): void {
    let state = this.#sessions.get(session);
    if (state === undefined) {
      state = {
        lastUsedAt: Date.now(),
        inFlight: 0,
      };
      this.#sessions.set(session, state);
    }

    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }

    state.inFlight += 1;
    state.lastUsedAt = Date.now();
  }

  #endSessionActivity(session: string): void {
    const state = this.#sessions.get(session);
    if (state === undefined) return;

    state.inFlight = Math.max(0, state.inFlight - 1);
    state.lastUsedAt = Date.now();

    if (this.#closing || state.inFlight > 0) {
      return;
    }

    if (!this.#enabled) {
      this.#startSessionCleanup(session, state);
      return;
    }

    this.#armSessionTimer(session, state);
    this.#enforceSessionLimit();
  }

  #armSessionTimer(
    session: string,
    state: BrowserSessionState,
  ): void {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
    }

    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.#startSessionCleanup(session, state);
    }, this.#sessionIdleMs);
  }

  #enforceSessionLimit(): void {
    const overflow =
      this.#sessions.size - this.#maxSessions;
    if (overflow <= 0) return;

    const candidates = [...this.#sessions.entries()]
      .filter(([, state]) => state.inFlight === 0)
      .sort(
        (left, right) =>
          left[1].lastUsedAt - right[1].lastUsedAt,
      )
      .slice(0, overflow);

    for (const [session, state] of candidates) {
      this.#startSessionCleanup(session, state);
    }
  }

  #startSessionCleanup(
    session: string,
    state: BrowserSessionState,
  ): void {
    if (
      this.#closing ||
      this.#sessions.get(session) !== state ||
      state.inFlight > 0
    ) {
      return;
    }

    this.#forgetSession(session);

    const task = this.#closeDetachedSession(
      session,
      state,
    );
    this.#pendingSessionCleanup.add(task);
    void task.finally(() => {
      this.#pendingSessionCleanup.delete(task);
    });
  }

  async #closeDetachedSession(
    session: string,
    state: BrowserSessionState,
  ): Promise<void> {
    try {
      await this.run(session, "close", []);
      this.#sessionCleanupError = undefined;
    } catch (error) {
      this.#sessionCleanupError =
        error instanceof Error
          ? error.message
          : String(error);

      if (
        !this.#closing &&
        !this.#sessions.has(session) &&
        this.#sessions.size < this.#maxSessions
      ) {
        state.inFlight = 0;
        state.lastUsedAt = Date.now();
        state.timer = undefined;
        this.#sessions.set(session, state);
        this.#armSessionTimer(session, state);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;

    for (const state of this.#sessions.values()) {
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
    }

    await Promise.allSettled([
      ...this.#pendingSessionCleanup,
    ]);

    const sessions = [...this.#sessions.keys()];
    await Promise.allSettled(
      sessions.map((session) =>
        this.run(session, "close", []),
      ),
    );

    for (const session of this.#sessions.keys()) {
      this.#forgetSession(session);
    }

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
  PlaywrightCliErrorCode,
  PlaywrightCliExecution,
  PlaywrightCliServiceOptions,
};
