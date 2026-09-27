import type { PlaywrightCliCommand } from "./playwright-cli-policy.js";

export type PlaywrightCliErrorCode =
  | "playwright_cli_disabled"
  | "playwright_cli_not_available"
  | "invalid_session"
  | "command_not_allowed"
  | "arguments_not_allowed"
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
