import { once } from "node:events";
import {
  mkdtemp,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  createConfigFromPolicy,
  spawnSandboxFromConfig,
} from "@microsoft/mxc-sdk";
import type {
  Capability,
  CapabilityExecution,
  CapabilityExecutionContext,
} from "./types.js";
import { buildWindowsCommandLine } from "./windows-command-line.js";

export interface MxcProcessCapabilityOptions {
  readonly key: string;
  readonly description: string;
  readonly executable: string;
  readonly allowedArgVectors?: readonly (readonly string[])[];
  readonly argumentPolicy?: (args: readonly string[]) => boolean;
  readonly fixedArgs?: readonly string[];
  readonly readonlyPaths?: readonly string[];
  readonly useWorkspacePortal?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly environment?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

interface WorkspaceRuntime {
  readonly sandboxCwd: string;
  readonly executorCwd: string;
  readonly readonlyPaths: readonly string[];
  dispose(): Promise<void>;
}

async function createWorkspaceRuntime(
  workspaceRoot: string,
  useWorkspacePortal: boolean,
): Promise<WorkspaceRuntime> {
  if (!useWorkspacePortal) {
    return {
      sandboxCwd: workspaceRoot,
      executorCwd: workspaceRoot,
      readonlyPaths: [],
      async dispose() {},
    };
  }

  const runtimeRoot = await mkdtemp(
    join(tmpdir(), "junius-mxc-runtime-"),
  );
  const workspacePortal = join(runtimeRoot, "workspace");

  try {
    await symlink(workspaceRoot, workspacePortal, "junction");
  } catch (error) {
    await rm(runtimeRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    sandboxCwd: workspacePortal,
    executorCwd: runtimeRoot,
    readonlyPaths: [runtimeRoot],
    async dispose() {
      try {
        await unlink(workspacePortal);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    },
  };
}

function matchesAllowedVector(
  args: readonly string[],
  allowed: readonly string[],
): boolean {
  return (
    args.length === allowed.length &&
    args.every((value, index) => value === allowed[index])
  );
}

function hostEnvironmentValue(...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function buildExplicitEnvironment(
  cwd: string,
  configured: NodeJS.ProcessEnv,
): string[] {
  const systemRoot =
    configured.SYSTEMROOT ??
    configured.SystemRoot ??
    hostEnvironmentValue("SYSTEMROOT", "SystemRoot");

  const localAppData =
    configured.LOCALAPPDATA ??
    configured.LocalAppData ??
    hostEnvironmentValue("LOCALAPPDATA", "LocalAppData");

  if (systemRoot === undefined) {
    throw new Error("SYSTEMROOT is required for MXC ProcessContainer.");
  }

  if (localAppData === undefined) {
    throw new Error("LOCALAPPDATA is required for MXC ProcessContainer.");
  }

  const entries = [
    `SYSTEMROOT=${systemRoot}`,
    `LOCALAPPDATA=${localAppData}`,
    `TEMP=${cwd}`,
    `TMP=${cwd}`,
  ];

  const reserved = new Set([
    "SYSTEMROOT",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
  ]);

  for (const [key, value] of Object.entries(configured)) {
    if (value === undefined || reserved.has(key.toUpperCase())) {
      continue;
    }

    entries.push(`${key}=${value}`);
  }

  return entries;
}

async function waitForClose(
  child: ChildProcess,
): Promise<[number | null, NodeJS.Signals | null]> {
  return (await once(child, "close")) as [
    number | null,
    NodeJS.Signals | null,
  ];
}

export class MxcProcessCapability implements Capability {
  readonly key: string;
  readonly description: string;

  readonly #executable: string;
  readonly #allowedArgVectors: readonly (readonly string[])[];
  readonly #argumentPolicy?: (args: readonly string[]) => boolean;
  readonly #fixedArgs: readonly string[];
  readonly #readonlyPaths: readonly string[];
  readonly #useWorkspacePortal: boolean;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: MxcProcessCapabilityOptions) {
    this.key = options.key;
    this.description = options.description;
    this.#executable = options.executable;
    this.#allowedArgVectors = options.allowedArgVectors ?? [];
    this.#argumentPolicy = options.argumentPolicy;
    this.#fixedArgs = options.fixedArgs ?? [];
    this.#readonlyPaths = options.readonlyPaths ?? [];
    this.#useWorkspacePortal = options.useWorkspacePortal ?? false;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#environment = options.environment ?? {};
  }

  async execute(
    args: readonly string[],
    context: CapabilityExecutionContext,
  ): Promise<CapabilityExecution> {
    const argumentsAllowed =
      this.#allowedArgVectors.some((allowed) =>
        matchesAllowedVector(args, allowed),
      ) ||
      this.#argumentPolicy?.(args) === true;

    if (!argumentsAllowed) {
      return {
        ok: false,
        code: "arguments_not_allowed",
        message: `Arguments are not allowed for capability ${this.key}.`,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
      };
    }

    if (process.platform !== "win32") {
      return {
        ok: false,
        code: "spawn_failed",
        message:
          "The current Junius MXC runtime integration is enabled only on Windows.",
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
      };
    }

    const startedAt = performance.now();
    const durationMs = () => Math.round(performance.now() - startedAt);

    let runtime: WorkspaceRuntime;
    try {
      runtime = await createWorkspaceRuntime(
        context.cwd,
        this.#useWorkspacePortal,
      );
    } catch (error) {
      return {
        ok: false,
        code: "spawn_failed",
        message: error instanceof Error ? error.message : String(error),
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: durationMs(),
      };
    }

    let environment: string[];
    try {
      environment = buildExplicitEnvironment(
        runtime.sandboxCwd,
        this.#environment,
      );
    } catch (error) {
      await runtime.dispose();
      return {
        ok: false,
        code: "spawn_failed",
        message: error instanceof Error ? error.message : String(error),
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: durationMs(),
      };
    }

    const config = createConfigFromPolicy(
      {
        version: "0.8.0-alpha",
        filesystem: {
          readwritePaths: [context.cwd],
          readonlyPaths: [
            dirname(this.#executable),
            ...this.#readonlyPaths,
            ...runtime.readonlyPaths,
          ],
        },
        network: {
          egress: { default: "deny" },
          ingress: { default: "deny", hostLoopback: "deny" },
        },
        ui: {
          allowWindows: true,
          clipboard: "none",
          allowInputInjection: false,
        },
        timeoutMs: this.#timeoutMs,
      },
      "process",
    );

    config.process!.commandLine = buildWindowsCommandLine(
      this.#executable,
      [...this.#fixedArgs, ...args],
    );
    config.process!.cwd = runtime.sandboxCwd;
    config.process!.env = environment;

    let child: ChildProcess;

    try {
      child = spawnSandboxFromConfig(
        config,
        {
          usePty: false,
          experimental: true,
          debug: false,
        },
        runtime.executorCwd,
      );
    } catch (error) {
      await runtime.dispose();
      return {
        ok: false,
        code: "spawn_failed",
        message: error instanceof Error ? error.message : String(error),
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: durationMs(),
      };
    }

    const disposeRuntime = (): void => {
      void runtime.dispose().catch((error: unknown) => {
        console.error("[mxc runtime cleanup]", error);
      });
    };

    child.once("close", disposeRuntime);
    child.once("error", disposeRuntime);

    return new Promise<CapabilityExecution>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let capturedBytes = 0;
      let settled = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;

      const capturedText = () => ({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });

      const finish = (result: CapabilityExecution): void => {
        if (settled) {
          return;
        }

        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolve(result);
      };

      const appendChunk = (
        target: Buffer[],
        chunk: Buffer | string,
      ): void => {
        if (settled) {
          return;
        }

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        capturedBytes += buffer.length;

        if (capturedBytes > this.#maxOutputBytes) {
          child.kill();
          const captured = capturedText();
          finish({
            ok: false,
            code: "output_limit",
            message: `Process output exceeded ${this.#maxOutputBytes} bytes.`,
            exitCode: null,
            signal: null,
            ...captured,
            durationMs: durationMs(),
          });
          return;
        }

        target.push(buffer);
      };

      child.stdout?.on("data", (chunk: Buffer | string) => {
        appendChunk(stdoutChunks, chunk);
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        appendChunk(stderrChunks, chunk);
      });

      child.once("error", (error) => {
        const captured = capturedText();
        finish({
          ok: false,
          code: "spawn_failed",
          message: error.message,
          exitCode: null,
          signal: null,
          ...captured,
          durationMs: durationMs(),
        });
      });

      void waitForClose(child).then(([exitCode, signal]) => {
        if (settled) {
          return;
        }

        const captured = capturedText();

        if (timedOut) {
          finish({
            ok: false,
            code: "process_timeout",
            message: `Process exceeded timeout of ${this.#timeoutMs} ms.`,
            exitCode,
            signal,
            ...captured,
            durationMs: durationMs(),
          });
          return;
        }

        if (exitCode === 0) {
          finish({
            ok: true,
            exitCode,
            ...captured,
            durationMs: durationMs(),
          });
          return;
        }

        finish({
          ok: false,
          code: "nonzero_exit",
          message: `Process exited with code ${String(exitCode)}.`,
          exitCode,
          signal,
          ...captured,
          durationMs: durationMs(),
        });
      });

      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, this.#timeoutMs);
    });
  }
}
