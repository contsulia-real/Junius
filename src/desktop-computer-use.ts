import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const REF_PATTERN = /^d\d+$/u;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
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

interface HelperResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly code?: string;
  readonly message?: string;
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

function localPythonCandidate(helperPath: string): string {
  const root = dirname(dirname(helperPath));

  if (process.platform === "win32") {
    return join(root, ".venv", "Scripts", "python.exe");
  }

  return join(root, ".venv", "bin", "python");
}

function resolvePythonExecutable(
  environment: NodeJS.ProcessEnv,
  helperPath: string,
  explicit?: string,
): string | undefined {
  const candidates = [
    explicit,
    environment.JUNIUS_PYTHON_PATH,
    localPythonCandidate(helperPath),
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return resolve(candidate);
    }
  }

  return undefined;
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
  readonly #helperPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #sessions = new Map<string, DesktopSessionState>();

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
      this.#helperPath,
      options.pythonExecutable,
    );
  }

  get available(): boolean {
    return (
      this.#platform === "win32" &&
      this.#pythonExecutable !== undefined &&
      existsSync(this.#helperPath)
    );
  }

  state(): {
    readonly available: boolean;
    readonly helperPath: string;
    readonly pythonExecutable?: string;
  } {
    return {
      available: this.available,
      helperPath: this.#helperPath,
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

    if (!this.available || this.#pythonExecutable === undefined) {
      throw new DesktopComputerUseError(
        "desktop_not_available",
        "Desktop computer use requires Windows, the Junius .venv Python interpreter, and python/desktop_helper.py. Set JUNIUS_PYTHON_PATH if Python lives elsewhere.",
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

  #executeHelper(
    request: Record<string, unknown>,
  ): Promise<HelperResponse> {
    const python = this.#pythonExecutable!;

    return new Promise<HelperResponse>((resolvePromise, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let timedOut = false;
      let outputLimit = false;

      const child = spawn(
        python,
        [this.#helperPath],
        {
          env: this.#environment,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      const finishError = (
        code: DesktopComputerUseErrorCode,
        message: string,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new DesktopComputerUseError(code, message));
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
            `Desktop helper output exceeded ${MAX_OUTPUT_BYTES} bytes.`,
          );
          return;
        }

        if (timedOut) {
          finishError(
            "process_timeout",
            `Desktop helper exceeded ${DEFAULT_TIMEOUT_MS} ms.`,
          );
          return;
        }

        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");

        if (exitCode !== 0) {
          finishError(
            "helper_failed",
            stderrText ||
              stdoutText ||
              `Desktop helper exited with code ${String(exitCode)}.`,
          );
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(stdoutText);
        } catch {
          finishError(
            "invalid_helper_response",
            "Desktop helper did not return valid JSON.",
          );
          return;
        }

        const record = asRecord(parsed);
        if (
          record === undefined ||
          typeof record.ok !== "boolean"
        ) {
          finishError(
            "invalid_helper_response",
            "Desktop helper returned an invalid response object.",
          );
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolvePromise(record as unknown as HelperResponse);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, DEFAULT_TIMEOUT_MS);

      child.stdin.end(JSON.stringify(request));
    });
  }
}
