export type ProcessExecutionErrorCode =
  | "process_timeout"
  | "output_limit"
  | "spawn_failed"
  | "nonzero_exit";

export type ProcessExecution =
  | {
      readonly ok: true;
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly durationMs: number;
    }
  | {
      readonly ok: false;
      readonly code: ProcessExecutionErrorCode;
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
