import type {
  Capability,
  CapabilityExecution,
  CapabilityExecutionContext,
  PrepareProcessResult,
} from "./types.js";
import { executePreparedProcess } from "./process-executor.js";

export interface ProcessCapabilityOptions {
  readonly key: string;
  readonly description: string;
  readonly executable: string;
  readonly allowedArgVectors?: readonly (readonly string[])[];
  readonly argumentPolicy?: (args: readonly string[]) => boolean;
  readonly preflight?: (
    args: readonly string[],
    context: CapabilityExecutionContext,
  ) =>
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly code: Extract<
          CapabilityExecution,
          { ok: false }
        >["code"];
        readonly message: string;
      };
  readonly fixedArgs?: readonly string[];
  readonly fixedArgsForExecution?: (
    args: readonly string[],
    context: CapabilityExecutionContext,
  ) => readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly inheritedEnvironmentDenyPrefixes?: readonly string[];
  readonly inheritedEnvironmentDenyNames?: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

function matchesAllowedVector(
  args: readonly string[],
  allowed: readonly string[],
): boolean {
  return (
    args.length === allowed.length &&
    args.every((value, index) => value === allowed[index])
  );
}

export class ProcessCapability implements Capability {
  readonly key: string;
  readonly description: string;

  readonly #executable: string;
  readonly #allowedArgVectors: readonly (readonly string[])[];
  readonly #argumentPolicy?: (args: readonly string[]) => boolean;
  readonly #preflight?: ProcessCapabilityOptions["preflight"];
  readonly #fixedArgs: readonly string[];
  readonly #fixedArgsForExecution?:
    ProcessCapabilityOptions["fixedArgsForExecution"];
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #inheritedEnvironment: NodeJS.ProcessEnv;
  readonly #inheritedEnvironmentDenyPrefixes: readonly string[];
  readonly #inheritedEnvironmentDenyNames: ReadonlySet<string>;

  constructor(options: ProcessCapabilityOptions) {
    this.key = options.key;
    this.description = options.description;
    this.#executable = options.executable;
    this.#allowedArgVectors = options.allowedArgVectors ?? [];
    this.#argumentPolicy = options.argumentPolicy;
    this.#preflight = options.preflight;
    this.#fixedArgs = options.fixedArgs ?? [];
    this.#fixedArgsForExecution =
      options.fixedArgsForExecution;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#environment = options.environment ?? {};
    this.#inheritedEnvironment =
      options.inheritedEnvironment ?? process.env;
    this.#inheritedEnvironmentDenyPrefixes =
      (options.inheritedEnvironmentDenyPrefixes ?? [])
        .map((prefix) => prefix.toUpperCase());
    this.#inheritedEnvironmentDenyNames = new Set(
      (options.inheritedEnvironmentDenyNames ?? [])
        .map((name) => name.toUpperCase()),
    );
  }

  prepareProcess(
    args: readonly string[],
    context: CapabilityExecutionContext,
  ): PrepareProcessResult {
    const argumentsAllowed =
      this.#allowedArgVectors.some((allowed) =>
        matchesAllowedVector(args, allowed),
      ) ||
      this.#argumentPolicy?.(args) === true;

    if (!argumentsAllowed) {
      return {
        ok: false,
        execution: {
          ok: false,
          code: "arguments_not_allowed",
          message: `Arguments are not allowed for capability ${this.key}.`,
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 0,
        },
      };
    }

    const preflight = this.#preflight?.(args, context);
    if (preflight !== undefined && !preflight.ok) {
      return {
        ok: false,
        execution: {
          ok: false,
          code: preflight.code,
          message: preflight.message,
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 0,
        },
      };
    }

    const inheritedEnvironment: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(this.#inheritedEnvironment)) {
      const normalizedName = name.toUpperCase();
      if (
        this.#inheritedEnvironmentDenyNames.has(normalizedName) ||
        this.#inheritedEnvironmentDenyPrefixes.some(
          (prefix) => normalizedName.startsWith(prefix),
        )
      ) {
        continue;
      }
      inheritedEnvironment[name] = value;
    }

    const executionFixedArgs =
      this.#fixedArgsForExecution?.(args, context) ?? [];

    return {
      ok: true,
      process: {
        executable: this.#executable,
        args: [
          ...this.#fixedArgs,
          ...executionFixedArgs,
          ...args,
        ],
        cwd: context.cwd,
        env: {
          ...inheritedEnvironment,
          ...this.#environment,
        },
        windowsHide: true,
      },
    };
  }

  async execute(
    args: readonly string[],
    context: CapabilityExecutionContext,
  ): Promise<CapabilityExecution> {
    const prepared =
      this.prepareProcess(
        args,
        context,
      );
    if (!prepared.ok) {
      return prepared.execution;
    }

    return executePreparedProcess(
      prepared.process,
      this.#timeoutMs,
      this.#maxOutputBytes,
    );
  }
}
