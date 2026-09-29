import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  DesktopHelperClient,
  DesktopHelperClientError,
  type DesktopHelperResponse,
} from "./desktop-helper-client.js";
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
  DESKTOP_KEY_MACRO_ACTIONS,
  DesktopComputerUseError,
  type DesktopComputerUseOptions,
  type DesktopExecution,
  type DesktopRunRequest,
} from "./desktop-computer-use-types.js";
import {
  desktopHelperRequest,
  transformDesktopHelperResult,
} from "./desktop-computer-use-adapter.js";
import { withoutEnvironmentVariables } from "./execution-environment.js";

export class DesktopComputerUseService {
  readonly #environment:
    NodeJS.ProcessEnv;
  readonly #pythonExecutable:
    string | undefined;
  readonly #helperPath: string;
  readonly #platform:
    NodeJS.Platform;
  #helperClient:
    DesktopHelperClient | undefined;

  constructor(
    options:
      DesktopComputerUseOptions = {},
  ) {
    this.#environment = {
      ...withoutEnvironmentVariables(
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
      ),
      PYTHONIOENCODING:
        "utf-8",
      PYTHONUTF8: "1",
    };
    this.#platform =
      options.platform ??
      process.platform;
    this.#helperPath = resolve(
      options.helperPath ??
        this.#environment
          .JUNIUS_DESKTOP_HELPER_PATH ??
        DEFAULT_DESKTOP_HELPER_PATH,
    );
    this.#pythonExecutable =
      resolveDesktopPythonExecutable(
        this.#helperPath,
        this.#environment,
        options.pythonExecutable,
      );
    this.#helperClient =
      this.#createHelperClient();
  }

  get available(): boolean {
    return (
      this.#platform === "win32" &&
      this.#pythonExecutable !==
        undefined &&
      existsSync(this.#helperPath)
    );
  }

  state(): {
    readonly available: boolean;
    readonly helperPath: string;
    readonly pythonExecutable?: string;
    readonly helperRunning: boolean;
    readonly helperReady: boolean;
  } {
    return {
      available: this.available,
      helperPath:
        this.#helperPath,
      helperRunning:
        this.#helperClient
          ?.running ??
        false,
      helperReady:
        this.#helperClient
          ?.ready ??
        false,
      ...(this.#pythonExecutable ===
      undefined
        ? {}
        : {
            pythonExecutable:
              this.#pythonExecutable,
          }),
    };
  }

  async run(
    request: DesktopRunRequest,
  ): Promise<DesktopExecution> {
    if (
      !DESKTOP_SESSION_PATTERN.test(
        request.session,
      )
    ) {
      throw new DesktopComputerUseError(
        "invalid_session",
        `Invalid desktop session name: ${request.session}`,
      );
    }

    if (
      !(
        DESKTOP_COMMANDS as readonly string[]
      ).includes(
        request.command,
      )
    ) {
      throw new DesktopComputerUseError(
        "command_not_allowed",
        `Desktop command is not allowed: ${request.command}`,
      );
    }

    if (
      !validateDesktopRequest(
        request,
      )
    ) {
      throw new DesktopComputerUseError(
        "arguments_not_allowed",
        `Arguments are not allowed for desktop command ${request.command}.`,
      );
    }

    if (
      !this.available ||
      this.#pythonExecutable ===
        undefined
    ) {
      throw new DesktopComputerUseError(
        "desktop_not_available",
        "Desktop computer use requires Windows, Junius's project-local .venv Python, and python/desktop_helper.py.",
      );
    }

    const startedAt =
      performance.now();
    const response =
      await this.#executeHelper(
        desktopHelperRequest(
          request,
        ),
      );

    if (!response.ok) {
      throw new DesktopComputerUseError(
        "helper_failed",
        response.message ??
          response.code ??
          "Desktop helper failed.",
      );
    }

    const transformed =
      transformDesktopHelperResult(
        request.command,
        response.result,
      );

    return {
      session:
        request.session,
      command:
        request.command,
      result:
        transformed.result,
      ...(transformed.image ===
      undefined
        ? {}
        : {
            image:
              transformed.image,
          }),
      durationMs: Math.round(
        performance.now() -
          startedAt,
      ),
    };
  }

  async close():
    Promise<void> {
    const helper =
      this.#helperClient;
    this.#helperClient =
      undefined;
    await helper?.close();
  }

  #createHelperClient():
    DesktopHelperClient | undefined {
    if (
      this.#pythonExecutable ===
      undefined
    ) {
      return undefined;
    }

    return new DesktopHelperClient({
      pythonExecutable:
        this.#pythonExecutable,
      helperPath:
        this.#helperPath,
      environment:
        this.#environment,
    });
  }

  async #executeHelper(
    request:
      Record<string, unknown>,
  ): Promise<DesktopHelperResponse> {
    if (
      this.#helperClient ===
      undefined
    ) {
      throw new DesktopComputerUseError(
        "desktop_not_available",
        "Desktop helper client is not available.",
      );
    }

    try {
      return await this
        .#helperClient.request(
          request,
        );
    } catch (error) {
      if (
        error instanceof
        DesktopHelperClientError
      ) {
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
  DESKTOP_KEY_MACRO_ACTIONS,
  DesktopComputerUseError,
};
export type {
  DesktopBatchAction,
  DesktopCommand,
  DesktopComputerUseErrorCode,
  DesktopComputerUseOptions,
  DesktopExecution,
  DesktopKeyMacroAction,
  DesktopKeyMacroStep,
  DesktopRunRequest,
} from "./desktop-computer-use-types.js";
