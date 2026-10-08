export const DESKTOP_COMMANDS = [
  "control_begin",
  "control_end",
  "windows",
  "screenshot",
  "focus_window",
  "mouse_move",
  "mouse_click",
  "mouse_down",
  "mouse_up",
  "mouse_wheel",
  "drag",
  "wait",
  "action_batch",
  "key_press",
  "key_down",
  "key_up",
  "key_macro",
  "clipboard_read",
  "clipboard_write",
  "type",
] as const;

export type DesktopCommand =
  (typeof DESKTOP_COMMANDS)[number];

export const DESKTOP_KEY_MACRO_ACTIONS = [
  "key_press",
  "key_down",
  "key_up",
] as const;

export type DesktopKeyMacroAction =
  (typeof DESKTOP_KEY_MACRO_ACTIONS)[number];

export interface DesktopKeyMacroStep {
  readonly action: DesktopKeyMacroAction;
  readonly key: string;
}

interface DesktopPointAction {
  readonly handle?: number;
  readonly x: number;
  readonly y: number;
}

export type DesktopBatchAction =
  | ({ readonly action: "focus_window"; readonly handle: number })
  | (DesktopPointAction & { readonly action: "mouse_move" })
  | (DesktopPointAction & {
      readonly action: "mouse_click";
      readonly button?: "left" | "right" | "middle";
      readonly clicks?: number;
    })
  | (DesktopPointAction & {
      readonly action: "mouse_down" | "mouse_up";
      readonly button?: "left" | "right" | "middle";
    })
  | (DesktopPointAction & {
      readonly action: "mouse_wheel";
      readonly amount: number;
    })
  | (DesktopPointAction & {
      readonly action: "drag";
      readonly toX: number;
      readonly toY: number;
      readonly button?: "left" | "right" | "middle";
      readonly durationMs?: number;
    })
  | { readonly action: "wait"; readonly durationMs: number }
  | {
      readonly action: "key_press" | "key_down" | "key_up";
      readonly key: string;
    }
  | {
      readonly action: "key_macro";
      readonly steps: readonly DesktopKeyMacroStep[];
    }
  | { readonly action: "clipboard_read" }
  | { readonly action: "clipboard_write" | "type"; readonly text: string };

export type DesktopComputerUseErrorCode =
  | "desktop_not_available"
  | "invalid_session"
  | "command_not_allowed"
  | "arguments_not_allowed"
  | "user_interrupted"
  | "control_not_started"
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
  readonly toX?: number;
  readonly toY?: number;
  readonly button?: "left" | "right" | "middle";
  readonly clicks?: number;
  readonly amount?: number;
  readonly durationMs?: number;
  readonly key?: string;
  readonly text?: string;
  readonly steps?: readonly DesktopKeyMacroStep[];
  readonly actions?: readonly DesktopBatchAction[];
  readonly screenshotAfter?: boolean;
  readonly screenshotHandle?: number;
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
