import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  DesktopHelperClient,
  DesktopHelperClientError,
  type DesktopHelperResponse,
} from "./desktop-helper-client.js";
import { fileURLToPath } from "node:url";
import {
  delimiter,
  dirname,
  join,
  resolve,
} from "node:path";

const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const REF_PATTERN = /^d\d+$/u;
const DEFAULT_HELPER_PATH = fileURLToPath(
  new URL("../python/desktop_helper.py", import.meta.url),
);

export const DESKTOP_COMMANDS = [
  "windows",
  "screenshot",
  "inspect",
  "invoke",
  "set_value",
  "focus",
  "focus_window",
  "mouse_move",
  "mouse_click",
  "mouse_down",
  "mouse_up",
  "mouse_wheel",
  "key_press",
  "key_down",
  "key_up",
  "type",
] as const;

export type DesktopCommand = (typeof DESKTOP_COMMANDS)[number];

export type DesktopComputerUseErrorCode =
  | "desktop_disabled"
  | "desktop_not_available"
  | "invalid_session"
  | "command_not_allowed"
  | "arguments_not_allowed"
  | "desktop_ref_not_found"
  | "spawn_failed"
  | "process_timeout"
  | "output_limit"
  | "helper_failed"
  | "invalid_helper_response";

export class DesktopComputerUseError extends Error {
  constructor(
    readonly code: DesktopComputerUseErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface DesktopElementRef {
  readonly handle: number;
  readonly path: readonly number[];
}

interface DesktopSessionState {
  readonly refs: Map<string, DesktopElementRef>;
  nextRef: number;
}

interface HelperImage {
  readonly mimeType: string;
  readonly data: string;
}

export interface DesktopRunRequest {
  readonly session: string;
  readonly command: DesktopCommand;
  readonly handle?: number;
  readonly ref?: string;
  readonly depth?: number;
  readonly x?: number;
  readonly y?: number;
  readonly button?: "left" | "right" | "middle";
  readonly clicks?: number;
  readonly amount?: number;
  readonly key?: string;
  readonly text?: string;
}

export interface DesktopExecution {
  readonly session: string;
  readonly command: DesktopCommand;
  readonly result: unknown;
  readonly image?: HelperImage;
  readonly durationMs: number;
}

export interface DesktopComputerUseOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly pythonExecutable?: string;
  readonly helperPath?: string;
  readonly platform?: NodeJS.Platform;
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

function resolvePythonExecutable(
  environment: NodeJS.ProcessEnv,
  explicit?: string,
): string | undefined {
  if (explicit !== undefined) {
    return existsSync(explicit)
      ? resolve(explicit)
      : undefined;
  }

  const names =
    process.platform === "win32"
      ? ["python.exe", "python3.exe"]
      : ["python3", "python"];

  for (const rawEntry of environmentPath(environment).split(delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/u, "$1");
    if (!entry) continue;

    for (const name of names) {
      const candidate = join(entry, name);
      if (existsSync(candidate)) {
        return resolve(candidate);
      }
    }
  }

  return undefined;
}

function hasDesktopPythonDependencies(
  pythonExecutable: string,
  environment: NodeJS.ProcessEnv,
): boolean {
  try {
    const result = spawnSync(
      pythonExecutable,
      [
        "-c",
        "import importlib.util,sys;sys.exit(0 if all(importlib.util.find_spec(x) for x in ('pyautogui','pywinauto','PIL')) else 1)",
      ],
      {
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: "ignore",
        timeout: 5_000,
      },
    );

    return result.status === 0;
  } catch {
    return false;
  }
}

function isFiniteInteger(value: number | undefined): value is number {
  return (
    value !== undefined &&
    Number.isInteger(value) &&
    Number.isFinite(value)
  );
}

function validateRequest(request: DesktopRunRequest): boolean {
  switch (request.command) {
    case "windows":
      return (
        request.handle === undefined &&
        request.ref === undefined
      );

    case "screenshot":
      return (
        request.handle === undefined ||
        (isFiniteInteger(request.handle) && request.handle > 0)
      );

    case "inspect":
      return (
        isFiniteInteger(request.handle) &&
        request.handle > 0 &&
        (request.depth === undefined ||
          (isFiniteInteger(request.depth) &&
            request.depth >= 0 &&
            request.depth <= 8))
      );

    case "invoke":
    case "focus":
      return request.ref !== undefined && REF_PATTERN.test(request.ref);

    case "set_value":
      return (
        request.ref !== undefined &&
        REF_PATTERN.test(request.ref) &&
        request.text !== undefined
      );

    case "focus_window":
      return isFiniteInteger(request.handle) && request.handle > 0;

    case "mouse_move":
    case "mouse_down":
    case "mouse_up":
      return (
        isFiniteInteger(request.x) &&
        isFiniteInteger(request.y) &&
        (request.handle === undefined ||
          (isFiniteInteger(request.handle) && request.handle > 0))
      );

    case "mouse_click":
      return (
        isFiniteInteger(request.x) &&
        isFiniteInteger(request.y) &&
        (request.handle === undefined ||
          (isFiniteInteger(request.handle) && request.handle > 0)) &&
        (request.clicks === undefined ||
          (isFiniteInteger(request.clicks) &&
            request.clicks >= 1 &&
            request.clicks <= 4))
      );

    case "mouse_wheel":
      return (
        isFiniteInteger(request.x) &&
        isFiniteInteger(request.y) &&
        isFiniteInteger(request.amount) &&
        (request.handle === undefined ||
          (isFiniteInteger(request.handle) && request.handle > 0))
      );

    case "key_press":
    case "key_down":
    case "key_up":
      return (
        request.key !== undefined &&
        request.key.length >= 1 &&
        request.key.length <= 64
      );

    case "type":
      return request.text !== undefined && request.text.length <= 65_536;
  }
}

function isHelperImage(value: unknown): value is HelperImage {
  return (
    typeof value === "object" &&
    value !== null &&
    "mimeType" in value &&
    "data" in value &&
    typeof value.mimeType === "string" &&
    typeof value.data === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export class DesktopComputerUseService {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #pythonExecutable: string | undefined;
  readonly #pythonReady: boolean;
  readonly #helperPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #sessions = new Map<string, DesktopSessionState>();
  readonly #helperClient: DesktopHelperClient | undefined;
  #enabled = true;

  constructor(options: DesktopComputerUseOptions = {}) {
    this.#environment = {
      ...process.env,
      ...options.environment,
    };
    this.#platform = options.platform ?? process.platform;
    this.#helperPath = resolve(
      options.helperPath ??
        this.#environment.JUNIUS_DESKTOP_HELPER_PATH ??
        DEFAULT_HELPER_PATH,
    );
    this.#pythonExecutable = resolvePythonExecutable(
      this.#environment,
      options.pythonExecutable,
    );
    this.#pythonReady =
      this.#pythonExecutable !== undefined &&
      (
        options.pythonExecutable !== undefined ||
        hasDesktopPythonDependencies(
          this.#pythonExecutable,
          this.#environment,
        )
      );
    this.#helperClient =
      !this.#pythonReady || this.#pythonExecutable === undefined
        ? undefined
        : new DesktopHelperClient({
            pythonExecutable: this.#pythonExecutable,
            helperPath: this.#helperPath,
            environment: this.#environment,
          });
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get available(): boolean {
    return (
      this.#platform === "win32" &&
      this.#pythonExecutable !== undefined &&
      this.#pythonReady &&
      existsSync(this.#helperPath)
    );
  }

  get active(): boolean {
    return this.#enabled && this.available;
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  state(): {
    readonly enabled: boolean;
    readonly available: boolean;
    readonly active: boolean;
    readonly helperPath: string;
    readonly pythonExecutable?: string;
    readonly pythonReady: boolean;
    readonly helperRunning: boolean;
  } {
    return {
      enabled: this.enabled,
      available: this.available,
      active: this.active,
      helperPath: this.#helperPath,
      pythonReady: this.#pythonReady,
      helperRunning: this.#helperClient?.running ?? false,
      ...(this.#pythonExecutable === undefined
        ? {}
        : { pythonExecutable: this.#pythonExecutable }),
    };
  }

  async run(request: DesktopRunRequest): Promise<DesktopExecution> {
    if (!SESSION_PATTERN.test(request.session)) {
      throw new DesktopComputerUseError(
        "invalid_session",
        `Invalid desktop session name: ${request.session}`,
      );
    }

    if (!(DESKTOP_COMMANDS as readonly string[]).includes(request.command)) {
      throw new DesktopComputerUseError(
        "command_not_allowed",
        `Desktop command is not allowed: ${request.command}`,
      );
    }

    if (!validateRequest(request)) {
      throw new DesktopComputerUseError(
        "arguments_not_allowed",
        `Arguments are not allowed for desktop command ${request.command}.`,
      );
    }

    if (!this.#enabled) {
      throw new DesktopComputerUseError(
        "desktop_disabled",
        "Desktop computer use is disabled by the Junius machine capability policy.",
      );
    }

    if (!this.available || this.#pythonExecutable === undefined) {
      throw new DesktopComputerUseError(
        "desktop_not_available",
        "Desktop computer use requires Windows, a Python interpreter on PATH, and python/desktop_helper.py.",
      );
    }

    const helperRequest = this.#toHelperRequest(request);
    const startedAt = performance.now();
    const response = await this.#executeHelper(helperRequest);

    if (!response.ok) {
      throw new DesktopComputerUseError(
        "helper_failed",
        response.message ??
          response.code ??
          "Desktop helper failed.",
      );
    }

    const transformed = this.#transformResult(
      request.session,
      request.command,
      response.result,
    );

    return {
      session: request.session,
      command: request.command,
      result: transformed.result,
      ...(transformed.image === undefined
        ? {}
        : { image: transformed.image }),
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  #session(name: string): DesktopSessionState {
    let state = this.#sessions.get(name);

    if (state === undefined) {
      state = {
        refs: new Map(),
        nextRef: 1,
      };
      this.#sessions.set(name, state);
    }

    return state;
  }

  #toHelperRequest(
    request: DesktopRunRequest,
  ): Record<string, unknown> {
    if (
      request.command === "invoke" ||
      request.command === "set_value" ||
      request.command === "focus"
    ) {
      const ref = request.ref!;
      const resolved = this.#session(request.session).refs.get(ref);

      if (resolved === undefined) {
        throw new DesktopComputerUseError(
          "desktop_ref_not_found",
          `Desktop ref is not available in session ${request.session}: ${ref}. Run inspect again.`,
        );
      }

      return {
        command: request.command,
        handle: resolved.handle,
        path: [...resolved.path],
        ...(request.text === undefined ? {} : { text: request.text }),
      };
    }

    return {
      command: request.command,
      ...(request.handle === undefined ? {} : { handle: request.handle }),
      ...(request.depth === undefined ? {} : { depth: request.depth }),
      ...(request.x === undefined ? {} : { x: request.x }),
      ...(request.y === undefined ? {} : { y: request.y }),
      ...(request.button === undefined ? {} : { button: request.button }),
      ...(request.clicks === undefined ? {} : { clicks: request.clicks }),
      ...(request.amount === undefined ? {} : { amount: request.amount }),
      ...(request.key === undefined ? {} : { key: request.key }),
      ...(request.text === undefined ? {} : { text: request.text }),
    };
  }

  #transformResult(
    sessionName: string,
    command: DesktopCommand,
    value: unknown,
  ): {
    readonly result: unknown;
    readonly image?: HelperImage;
  } {
    if (command === "inspect") {
      const record = asRecord(value);
      const elements = record?.elements;

      if (
        record === undefined ||
        !Array.isArray(elements) ||
        typeof record.handle !== "number"
      ) {
        throw new DesktopComputerUseError(
          "invalid_helper_response",
          "Desktop inspect helper returned an invalid response.",
        );
      }

      const session = this.#session(sessionName);
      session.refs.clear();
      session.nextRef = 1;

      const mapped = elements.map((element) => {
        const item = asRecord(element);
        const path = item?.path;

        if (
          item === undefined ||
          !Array.isArray(path) ||
          !path.every((part) => Number.isInteger(part))
        ) {
          throw new DesktopComputerUseError(
            "invalid_helper_response",
            "Desktop inspect helper returned an invalid element.",
          );
        }

        const ref = `d${session.nextRef}`;
        session.nextRef += 1;
        session.refs.set(ref, {
          handle: record.handle as number,
          path: path as number[],
        });

        const { path: _path, ...metadata } = item;

        return {
          ref,
          ...metadata,
        };
      });

      return {
        result: {
          ...record,
          elements: mapped,
        },
      };
    }

    if (command === "screenshot") {
      const record = asRecord(value);
      const image = record?.image;

      if (record === undefined || !isHelperImage(image)) {
        throw new DesktopComputerUseError(
          "invalid_helper_response",
          "Desktop screenshot helper returned an invalid image.",
        );
      }

      const { image: _image, ...metadata } = record;

      return {
        result: metadata,
        image,
      };
    }

    return { result: value };
  }

  async close(): Promise<void> {
    await this.#helperClient?.close();
  }

  async #executeHelper(
    request: Record<string, unknown>,
  ): Promise<DesktopHelperResponse> {
    if (this.#helperClient === undefined) {
      throw new DesktopComputerUseError(
        "desktop_not_available",
        "Desktop helper client is not available.",
      );
    }

    try {
      return await this.#helperClient.request(request);
    } catch (error) {
      if (error instanceof DesktopHelperClientError) {
        throw new DesktopComputerUseError(
          error.code,
          error.message,
        );
      }

      throw error;
    }
  }
}
