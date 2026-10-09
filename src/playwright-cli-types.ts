export type PlaywrightCliCommand = string;

export type PlaywrightCliErrorCode =
  | "playwright_cli_closing"
  | "playwright_cli_not_available"
  | "invalid_session"
  | "data_cleanup_failed"
  | "spawn_failed"
  | "process_timeout"
  | "output_limit"
  | "nonzero_exit";

export class PlaywrightCliError extends Error {
  constructor(
    readonly code: PlaywrightCliErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PlaywrightCliServiceOptions {
  readonly sessionIdleMs?: number;
  readonly maxSessions?: number;
  readonly retainData?: boolean;
}

export interface PlaywrightCliExecution {
  readonly session: string;
  readonly command: PlaywrightCliCommand;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly transport: "broker" | "spawn";
}
