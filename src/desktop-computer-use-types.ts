export const DESKTOP_COMMANDS = [
  "windows",
  "screenshot",
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

export type DesktopCommand =
  (typeof DESKTOP_COMMANDS)[number];

export type DesktopComputerUseErrorCode =
  | "desktop_disabled"
  | "desktop_not_available"
  | "invalid_session"
  | "command_not_allowed"
  | "arguments_not_allowed"
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

export interface DesktopHelperImage {
  readonly mimeType: string;
  readonly data: string;
}

export interface DesktopRunRequest {
  readonly session: string;
  readonly command: DesktopCommand;
  readonly handle?: number;
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
  readonly image?: DesktopHelperImage;
  readonly durationMs: number;
}

export interface DesktopComputerUseOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly pythonExecutable?: string;
  readonly helperPath?: string;
  readonly platform?: NodeJS.Platform;
}
