export interface CapabilityExecutionContext {
  readonly cwd: string;
}

export type CapabilityExecutionErrorCode =
  | "arguments_not_allowed"
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

export interface Capability {
  readonly key: string;
  readonly description: string;

  execute(
    args: readonly string[],
    context: CapabilityExecutionContext,
  ): Promise<CapabilityExecution>;
}
