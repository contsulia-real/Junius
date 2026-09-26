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
}

export interface PlaywrightCliExecution {
  readonly session: string;
  readonly command: PlaywrightCliCommand;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
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
  nodeExecutable: string,
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
    return {
      executable: nodeExecutable,
      fixedArgs: [candidate],
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

function defaultBrowserStatePath(
  environment: NodeJS.ProcessEnv,
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

function candidatePaths(
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  const candidates: string[] = [];

  if (environment.JUNIUS_PLAYWRIGHT_CLI_PATH) {
    candidates.push(environment.JUNIUS_PLAYWRIGHT_CLI_PATH);
  }

  const playwrightCliHome = environment.PLAYWRIGHT_CLI_HOME;
  if (playwrightCliHome) {
    candidates.push(
      join(playwrightCliHome, "playwright-cli.exe"),
      join(playwrightCliHome, "playwright-cli"),
      join(playwrightCliHome, "playwright-cli.js"),
      join(
        playwrightCliHome,
        "node_modules",
        "@playwright",
        "cli",
        "playwright-cli.js",
      ),
    );
  }

  for (const rawEntry of (environment.PATH ?? "").split(delimiter)) {
    const entry = rawEntry.trim();
    if (!entry) {
      continue;
    }

    candidates.push(
      join(entry, "playwright-cli.exe"),
      join(entry, "playwright-cli"),
      join(entry, "playwright-cli.js"),
      join(entry, "playwright-cli.cjs"),
      join(entry, "playwright-cli.mjs"),
      join(entry, "playwright-cli.cmd"),
      join(
        entry,
        "node_modules",
        "@playwright",
        "cli",
        "playwright-cli.js",
      ),
    );
  }

  return [...new Set(candidates)];
}

export function resolvePlaywrightCliLauncher(
  environment: NodeJS.ProcessEnv = process.env,
  nodeExecutable = process.execPath,
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

  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    nodeExecutable = process.execPath,
  ) {
    this.#environment = { ...environment };
    this.#statePath = defaultBrowserStatePath(environment);
    this.#launcher = resolvePlaywrightCliLauncher(
      environment,
      nodeExecutable,
    );
  }

  get available(): boolean {
    return this.#launcher !== undefined;
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

    if (this.#launcher === undefined) {
      throw new PlaywrightCliError(
        "playwright_cli_not_available",
        "playwright-cli was not found. Install @playwright/cli globally or set JUNIUS_PLAYWRIGHT_CLI_PATH to its executable or playwright-cli.js entry.",
      );
    }

    const launcher = this.#launcher;

    await mkdir(this.#statePath, { recursive: true });

    const startedAt = performance.now();

    return new Promise<PlaywrightCliExecution>((resolvePromise, reject) => {
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
          ...commandArgs(session, command, args),
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
          outputLimit = true;
          child.kill();
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
        resolvePromise({
          session,
          command,
          exitCode: 0,
          stdout: stdoutText,
          stderr: stderrText,
          durationMs: Math.round(performance.now() - startedAt),
        });
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, DEFAULT_TIMEOUT_MS);
    });
  }
}
