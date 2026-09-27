import { existsSync } from "node:fs";
import {
  DesktopHelperClient,
  DesktopHelperClientError,
  type DesktopHelperResponse,
} from "./desktop-helper-client.js";
import { withoutEnvironmentVariables } from "./execution-environment.js";
import { resolve } from "node:path";
import {
  DEFAULT_DESKTOP_HELPER_PATH,
  resolveDesktopPythonExecutable,
} from "./desktop-computer-use-launcher.js";
import {
  DESKTOP_SESSION_PATTERN,
  validateDesktopRequest,
} from "./desktop-computer-use-policy.js";
import {
  DESKTOP_COMMANDS,
  DesktopComputerUseError,
  type DesktopCommand,
  type DesktopComputerUseOptions,
  type DesktopExecution,
  type DesktopHelperImage,
  type DesktopRunRequest,
} from "./desktop-computer-use-types.js";
import {
  DesktopSessionRegistry,
} from "./desktop-session-registry.js";

const DEFAULT_SESSION_IDLE_MS = 5 * 60_000;
const DEFAULT_MAX_SESSIONS = 64;

function isHelperImage(
  value: unknown,
): value is DesktopHelperImage {
  return (
    typeof value === "object" &&
    value !== null &&
    "mimeType" in value &&
    "data" in value &&
    typeof value.mimeType === "string" &&
    typeof value.data === "string"
  );
}

function asRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export class DesktopComputerUseService {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #pythonExecutable: string | undefined;
  readonly #helperPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #sessions: DesktopSessionRegistry;
  #helperClient: DesktopHelperClient | undefined;
  #enabled = true;

  constructor(options: DesktopComputerUseOptions = {}) {
    this.#environment = withoutEnvironmentVariables(
      {
        ...process.env,
        ...options.environment,
      },
      {
        names: [
          "PYTHONPATH",
          "PYTHONHOME",
          "PYTHONSTARTUP",
          "PYTHONINSPECT",
        ],
      },
    );
    this.#platform = options.platform ?? process.platform;
    const sessionIdleMs = Math.max(
      1,
      Math.floor(
        options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS,
      ),
    );
    const maxSessions = Math.max(
      1,
      Math.floor(
        options.maxSessions ?? DEFAULT_MAX_SESSIONS,
      ),
    );
    this.#sessions =
      new DesktopSessionRegistry(
        sessionIdleMs,
        maxSessions,
      );
    this.#helperPath = resolve(
      options.helperPath ??
        this.#environment.JUNIUS_DESKTOP_HELPER_PATH ??
        DEFAULT_DESKTOP_HELPER_PATH,
    );
    this.#pythonExecutable = resolveDesktopPythonExecutable(
      this.#helperPath,
      this.#environment,
      options.pythonExecutable,
    );
    this.#helperClient = this.#createHelperClient();
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get available(): boolean {
    return (
      this.#platform === "win32" &&
      this.#pythonExecutable !== undefined &&
      existsSync(this.#helperPath)
    );
  }

  get active(): boolean {
    return this.#enabled && this.available;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (this.#enabled === enabled) return;

    this.#enabled = enabled;

    if (!enabled) {
      this.#sessions.clear();
      const helper = this.#helperClient;
      this.#helperClient = undefined;
      await helper?.close();
      return;
    }

    if (this.#helperClient === undefined) {
      this.#helperClient = this.#createHelperClient();
    }
  }

  state(): {
    readonly enabled: boolean;
    readonly available: boolean;
    readonly active: boolean;
    readonly helperPath: string;
    readonly pythonExecutable?: string;
    readonly helperRunning: boolean;
    readonly helperReady: boolean;
    readonly sessionCount: number;
  } {
    return {
      enabled: this.enabled,
      available: this.available,
      active: this.active,
      helperPath: this.#helperPath,
      helperRunning: this.#helperClient?.running ?? false,
      helperReady: this.#helperClient?.ready ?? false,
      sessionCount: this.#sessions.count,
      ...(this.#pythonExecutable === undefined
        ? {}
        : { pythonExecutable: this.#pythonExecutable }),
    };
  }

  async prewarm(): Promise<void> {
    if (!this.active || this.#helperClient === undefined) {
      return;
    }

    try {
      await this.#helperClient.prewarm();
    } catch {
      // Prewarming is opportunistic. A real request can retry lazily.
    }
  }

  async run(request: DesktopRunRequest): Promise<DesktopExecution> {
    if (!DESKTOP_SESSION_PATTERN.test(request.session)) {
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

    if (!validateDesktopRequest(request)) {
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
        "Desktop computer use requires Windows, Junius's project-local .venv Python, and python/desktop_helper.py.",
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

  #toHelperRequest(
    request: DesktopRunRequest,
  ): Record<string, unknown> {
    if (
      request.command === "invoke" ||
      request.command === "set_value" ||
      request.command === "focus"
    ) {
      const ref = request.ref!;
      const resolved = this.#sessions.session(request.session).refs.get(ref);

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
    readonly image?: DesktopHelperImage;
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

      const session = this.#sessions.session(sessionName);
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
    this.#sessions.clear();
    const helper = this.#helperClient;
    this.#helperClient = undefined;
    await helper?.close();
  }

  #createHelperClient(): DesktopHelperClient | undefined {
    if (this.#pythonExecutable === undefined) {
      return undefined;
    }

    return new DesktopHelperClient({
      pythonExecutable: this.#pythonExecutable,
      helperPath: this.#helperPath,
      environment: this.#environment,
    });
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


export {
  DESKTOP_COMMANDS,
  DesktopComputerUseError,
};
export type {
  DesktopCommand,
  DesktopComputerUseErrorCode,
  DesktopComputerUseOptions,
  DesktopExecution,
  DesktopRunRequest,
} from "./desktop-computer-use-types.js";
