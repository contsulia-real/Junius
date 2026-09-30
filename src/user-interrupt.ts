import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveDesktopPythonExecutable } from "./desktop-computer-use-launcher.js";
import { withoutEnvironmentVariables } from "./execution-environment.js";
import { terminateProcessTree } from "./process-termination.js";

export const DEFAULT_USER_INTERRUPT_HELPER_PATH =
  fileURLToPath(
    new URL(
      "../python/user_interrupt.py",
      import.meta.url,
    ),
  );

export interface UserInterruptLease {
  readonly signal: AbortSignal;
  release(): void;
}

export interface UserInterruptSource {
  arm():
    | UserInterruptLease
    | Promise<UserInterruptLease>;
}

export interface EscapeInterruptServiceOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly pythonExecutable?: string;
  readonly helperPath?: string;
  readonly platform?: NodeJS.Platform;
}

export class EscapeInterruptService
  implements UserInterruptSource
{
  readonly #environment:
    NodeJS.ProcessEnv;
  readonly #helperPath: string;
  readonly #pythonExecutable:
    string | undefined;
  readonly #platform:
    NodeJS.Platform;
  readonly #controllers =
    new Set<AbortController>();
  #child:
    ChildProcessWithoutNullStreams | undefined;
  #buffer = "";
  #ready = false;
  #readyPromise:
    Promise<void> | undefined;
  #readyResolve:
    (() => void) | undefined;
  #readyReject:
    ((error: Error) => void) | undefined;
  #closing = false;

  constructor(
    options:
      EscapeInterruptServiceOptions = {},
  ) {
    this.#environment =
      withoutEnvironmentVariables(
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
    this.#helperPath =
      options.helperPath ??
      DEFAULT_USER_INTERRUPT_HELPER_PATH;
    this.#pythonExecutable =
      resolveDesktopPythonExecutable(
        this.#helperPath,
        this.#environment,
        options.pythonExecutable,
      );
    this.#platform =
      options.platform ??
      process.platform;
  }

  get available(): boolean {
    return (
      this.#platform === "win32" &&
      this.#pythonExecutable !==
        undefined &&
      existsSync(this.#helperPath)
    );
  }

  async arm(): Promise<UserInterruptLease> {
    const controller =
      new AbortController();

    if (
      this.available &&
      !this.#closing
    ) {
      this.#ensureChild();
      await this.#readyPromise;
      this.#controllers.add(
        controller,
      );
    }

    let released = false;
    return {
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        this.#controllers.delete(
          controller,
        );
      },
    };
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#controllers.clear();

    const child = this.#child;
    this.#child = undefined;
    this.#buffer = "";
    this.#rejectReady(
      new Error(
        "Escape interrupt service closed.",
      ),
    );

    if (
      child !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      await terminateProcessTree(
        child,
        this.#environment,
      );
    }
  }

  #ensureChild(): void {
    if (
      this.#child !== undefined &&
      this.#child.exitCode === null &&
      this.#child.signalCode === null
    ) {
      return;
    }
    if (
      this.#pythonExecutable ===
      undefined
    ) {
      return;
    }

    this.#ready = false;
    this.#readyPromise =
      new Promise<void>(
        (resolvePromise, reject) => {
          this.#readyResolve =
            resolvePromise;
          this.#readyReject = reject;
        },
      );
    void this.#readyPromise.catch(
      () => {},
    );

    const child = spawn(
      this.#pythonExecutable,
      [
        this.#helperPath,
        "--stream",
      ],
      {
        env: {
          ...this.#environment,
          PYTHONIOENCODING:
            "utf-8",
          PYTHONUTF8: "1",
        },
        shell: false,
        windowsHide: true,
        stdio: [
          "pipe",
          "pipe",
          "pipe",
        ],
      },
    );
    this.#child = child;
    this.#buffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on(
      "data",
      (chunk: string) => {
        this.#buffer += chunk;
        for (;;) {
          const newline =
            this.#buffer.indexOf(
              "\n",
            );
          if (newline < 0) break;

          const line =
            this.#buffer.slice(
              0,
              newline,
            );
          this.#buffer =
            this.#buffer.slice(
              newline + 1,
            );
          if (!line.trim()) continue;

          try {
            const record =
              JSON.parse(
                line,
              ) as {
                event?: unknown;
              };
            if (
              record.event ===
              "ready"
            ) {
              this.#markReady();
            } else if (
              record.event ===
              "escape"
            ) {
              this.#interrupt();
            }
          } catch {
            // Ignore malformed monitor output.
          }
        }
      },
    );

    child.once(
      "error",
      (error) => {
        if (
          this.#child !== child
        ) {
          return;
        }
        this.#child = undefined;
        this.#buffer = "";
        this.#rejectReady(error);
      },
    );

    child.once(
      "close",
      () => {
        if (
          this.#child === child
        ) {
          this.#child =
            undefined;
          this.#buffer = "";
          this.#rejectReady(
            new Error(
              "Escape interrupt helper exited.",
            ),
          );
        }
      },
    );
  }

  #markReady(): void {
    if (this.#ready) return;
    this.#ready = true;
    this.#readyResolve?.();
    this.#readyResolve = undefined;
    this.#readyReject = undefined;
  }

  #rejectReady(error: Error): void {
    if (this.#ready) {
      this.#ready = false;
    }
    this.#readyReject?.(
      error,
    );
    this.#readyResolve = undefined;
    this.#readyReject = undefined;
    this.#readyPromise = undefined;
  }

  #interrupt(): void {
    const controllers = [
      ...this.#controllers,
    ];
    this.#controllers.clear();

    for (
      const controller
      of controllers
    ) {
      controller.abort(
        new Error(
          "user_interrupted",
        ),
      );
    }
  }
}
