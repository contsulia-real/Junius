export interface CapabilityExecutionContext {
  readonly cwd: string;
}

export type CapabilityExecutionErrorCode =
  | "arguments_not_allowed"
  | "unsafe_repository_config"
  | "process_timeout"
  | "output_limit"
  | "spawn_failed"
  | "nonzero_exit";

export type CapabilityExecution =
  | {
      readonly ok: true;
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly durationMs: number;
    }
  | {
      readonly ok: false;
      readonly code: CapabilityExecutionErrorCode;
      readonly message: string;
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly durationMs: number;
    };

export interface PreparedProcess {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly windowsHide: boolean;
}

export type PrepareProcessResult =
  | {
      readonly ok: true;
      readonly process: PreparedProcess;
    }
  | {
      readonly ok: false;
      readonly execution: Extract<CapabilityExecution, { ok: false }>;
    };

export interface Capability {
  readonly key: string;
  readonly description: string;

  execute(
    args: readonly string[],
    context: CapabilityExecutionContext,
  ): Promise<CapabilityExecution>;
}

export interface ProcessPreparableCapability extends Capability {
  prepareProcess(
    args: readonly string[],
    context: CapabilityExecutionContext,
  ): PrepareProcessResult;
}

export function isProcessPreparableCapability(
  capability: Capability,
): capability is ProcessPreparableCapability {
  return (
    "prepareProcess" in capability &&
    typeof capability.prepareProcess === "function"
  );
}
