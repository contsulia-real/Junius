import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import {
  PlaywrightCliBrokerClient,
  PlaywrightCliBrokerError,
} from "./playwright-cli-broker-client.js";
import { resolveNodeExecutable } from "./capabilities/node-capability.js";
import { terminateProcessTree } from "./process-termination.js";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REF_PATTERN = /^e\d+$/u;
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

export const PLAYWRIGHT_CLI_COMMANDS = [
  "open",
  "goto",
  "snapshot",
  "find",
  "click",
  "dblclick",
  "fill",
  "type",
  "press",
  "keydown",
  "keyup",
  "hover",
  "select",
  "check",
  "uncheck",
  "drag",
  "dialog-accept",
  "dialog-dismiss",
  "resize",
  "go-back",
  "go-forward",
  "reload",
  "mousemove",
  "mousedown",
  "mouseup",
  "mousewheel",
  "tab-list",
  "tab-new",
  "tab-close",
  "tab-select",
  "close",
] as const;

export type PlaywrightCliCommand =
  (typeof PLAYWRIGHT_CLI_COMMANDS)[number];

export type PlaywrightCliErrorCode =
  | "playwright_cli_disabled"
  | "playwright_cli_not_available"
  | "invalid_session"
  | "command_not_allowed"
  | "arguments_not_allowed"
  | "spawn_failed"
  | "process_timeout"
  | "output_limit"
  | "nonzero_exit";

export class PlaywrightCliError extends Error {
  constructor(
    readonly code: PlaywrightCliErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface PlaywrightCliLauncher {
  readonly executable: string;
  readonly fixedArgs: readonly string[];
  readonly entryPath?: string;
}

export interface PlaywrightCliServiceOptions {
  readonly sessionIdleMs?: number;
  readonly maxSessions?: number;
}

interface BrowserSessionState {
  lastUsedAt: number;
  inFlight: number;
  timer?: NodeJS.Timeout;
}

export interface PlaywrightCliExecution {
  readonly session: string;
  readonly command: PlaywrightCliCommand;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly transport: "broker" | "spawn";
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isPortableExecutable(path: string): boolean {
  let handle: number | undefined;

  try {
    handle = openSync(path, "r");
    const header = Buffer.allocUnsafe(2);
    const bytesRead = readSync(handle, header, 0, 2, 0);
    return bytesRead === 2 && header[0] === 0x4d && header[1] === 0x5a;
  } catch {
    return false;
  } finally {
    if (handle !== undefined) {
      closeSync(handle);
    }
  }
}

function launcherFromCandidate(
  candidate: string,
  nodeExecutable: string | undefined,
): PlaywrightCliLauncher | undefined {
  if (!isFile(candidate)) {
    return undefined;
  }

  const extension = extname(candidate).toLowerCase();

  if (extension === ".exe" || isPortableExecutable(candidate)) {
    return {
      executable: candidate,
      fixedArgs: [],
    };
  }

  if ([".js", ".cjs", ".mjs"].includes(extension)) {
    if (nodeExecutable === undefined) return undefined;

    return {
      executable: nodeExecutable,
      fixedArgs: [candidate],
      entryPath: candidate,
    };
  }

  return undefined;
}

function targetFromWindowsCmdShim(
  shimPath: string,
): string | undefined {
  if (process.platform !== "win32" || extname(shimPath).toLowerCase() !== ".cmd") {
    return undefined;
  }

  try {
    const text = readFileSync(shimPath, "utf8");
    const match = text.match(
      /["']?([^"'\r\n]*playwright-cli\.js)["']?/iu,
    );

    if (match?.[1] === undefined) {
      return undefined;
    }

    const expanded = match[1]
      .replaceAll("%dp0%", dirname(shimPath) + "\\")
      .replaceAll("%~dp0", dirname(shimPath) + "\\");

    return isAbsolute(expanded)
      ? resolve(expanded)
      : resolve(dirname(shimPath), expanded);
  } catch {
    return undefined;
  }
}

export function resolveBrowserStatePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.JUNIUS_BROWSER_STATE_PATH) {
    return environment.JUNIUS_BROWSER_STATE_PATH;
  }

  if (process.platform === "win32") {
    const localAppData =
      environment.LOCALAPPDATA ??
      join(homedir(), "AppData", "Local");

    return join(localAppData, "Junius", "browser");
  }

  const stateRoot =
    environment.XDG_STATE_HOME ??
    join(homedir(), ".local", "state");

  return join(stateRoot, "Junius", "browser");
}

function environmentPath(
  environment: NodeJS.ProcessEnv,
): string {
  return (
    environment.PATH ??
    environment.Path ??
    environment.path ??
    ""
  );
}

function candidatePaths(
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  const candidates: string[] = [];

  for (const rawEntry of environmentPath(environment).split(delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/u, "$1");
    if (!entry) continue;

    candidates.push(
      join(entry, "playwright-cli.exe"),
      join(entry, "playwright-cli"),
      join(entry, "playwright-cli.js"),
      join(entry, "playwright-cli.cjs"),
      join(entry, "playwright-cli.mjs"),
      join(entry, "playwright-cli.cmd"),
    );
  }

  return candidates;
}

export function resolvePlaywrightCliLauncher(
  environment: NodeJS.ProcessEnv = process.env,
  nodeExecutable = resolveNodeExecutable(environment),
): PlaywrightCliLauncher | undefined {
  for (const candidate of candidatePaths(environment)) {
    const direct = launcherFromCandidate(candidate, nodeExecutable);
    if (direct) {
      return direct;
    }

    const shimTarget = targetFromWindowsCmdShim(candidate);
    if (shimTarget) {
      const resolved = launcherFromCandidate(shimTarget, nodeExecutable);
      if (resolved) {
        return resolved;
      }
    }
  }

  return undefined;
}

function supportsPersistentBroker(
  entryPath: string | undefined,
): entryPath is string {
  if (entryPath === undefined) return false;

  try {
    const source = readFileSync(entryPath, "utf8");
    return /\{\s*program\s*\}\s*=\s*require\(["'][^"']+["']\)/u.test(
      source,
    );
  } catch {
    return false;
  }
}

function isInteger(value: string): boolean {
  return /^-?\d+$/u.test(value);
}

function isRef(value: string): boolean {
  return REF_PATTERN.test(value);
}

function isButton(value: string): boolean {
  return ["left", "right", "middle"].includes(value);
}

function isOpenOption(value: string): boolean {
  return (
    value === "--headed" ||
    value === "--mobile" ||
    value === "--persistent" ||
    /^--browser=(chromium|chrome|msedge|firefox|webkit)$/u.test(value) ||
    /^--device=.{1,128}$/u.test(value) ||
    /^--idle-timeout=\d+$/u.test(value)
  );
}

function validateArgs(
  command: PlaywrightCliCommand,
  args: readonly string[],
): boolean {
  switch (command) {
    case "open": {
      let positional = 0;
      for (const arg of args) {
        if (arg.startsWith("--")) {
          if (!isOpenOption(arg)) return false;
        } else {
          positional += 1;
          if (positional > 1) return false;
        }
      }
      return true;
    }

    case "goto":
      return args.length === 1 && !args[0]!.startsWith("-");

    case "snapshot":
      return (
        args.length <= 3 &&
        args.every(
          (arg) =>
            isRef(arg) ||
            arg === "--boxes" ||
            /^--depth=\d+$/u.test(arg),
        ) &&
        args.filter(isRef).length <= 1
      );

    case "find":
      return (
        (args.length === 1 && args[0]!.length > 0) ||
        (args.length === 2 &&
          args[0] === "--regex" &&
          args[1]!.length > 0)
      );

    case "click":
    case "dblclick":
      return (
        (args.length === 1 && isRef(args[0]!)) ||
        (args.length === 2 &&
          isRef(args[0]!) &&
          isButton(args[1]!))
      );

    case "fill":
      return (
        (args.length === 2 && isRef(args[0]!)) ||
        (args.length === 3 &&
          isRef(args[0]!) &&
          args[2] === "--submit")
      );

    case "type":
      return args.length === 1;

    case "press":
    case "keydown":
    case "keyup":
      return args.length === 1 && args[0]!.length > 0;

    case "hover":
    case "check":
    case "uncheck":
      return args.length === 1 && isRef(args[0]!);

    case "select":
      return args.length === 2 && isRef(args[0]!);

    case "drag":
      return (
        args.length === 2 &&
        isRef(args[0]!) &&
        isRef(args[1]!)
      );

    case "dialog-accept":
      return args.length <= 1;

    case "dialog-dismiss":
    case "go-back":
    case "go-forward":
    case "reload":
    case "tab-list":
    case "close":
      return args.length === 0;

    case "resize":
    case "mousemove":
    case "mousewheel":
      return (
        args.length === 2 &&
        isInteger(args[0]!) &&
        isInteger(args[1]!)
      );

    case "mousedown":
    case "mouseup":
      return (
        args.length === 0 ||
        (args.length === 1 && isButton(args[0]!))
      );

    case "tab-new":
      return (
        args.length === 0 ||
        (args.length === 1 && !args[0]!.startsWith("-"))
      );

    case "tab-close":
      return (
        args.length === 0 ||
        (args.length === 1 && /^\d+$/u.test(args[0]!))
      );

    case "tab-select":
      return args.length === 1 && /^\d+$/u.test(args[0]!);
  }
}

function commandArgs(
  session: string,
  command: PlaywrightCliCommand,
  args: readonly string[],
): readonly string[] {
  const prefix = [`-s=${session}`];

  if (command === "snapshot") {
    prefix.push("--raw");
  }

  const commandSpecific = [...args];

  if (command === "open") {
    if (!commandSpecific.includes("--persistent")) {
      commandSpecific.push("--persistent");
    }

    if (!commandSpecific.includes("--headed")) {
      commandSpecific.push("--headed");
    }
  }

  return [...prefix, command, ...commandSpecific];
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
    this.#environment = { ...environment };
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

    if (!validateArgs(command, args)) {
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
    const cliArgs = commandArgs(session, command, args);

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
