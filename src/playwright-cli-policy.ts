const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REF_PATTERN = /^e\d+$/u;

export const PLAYWRIGHT_CLI_COMMANDS = [
  "open",
  "goto",
  "snapshot",
  "find",
  "click",
  "dblclick",
  "fill",
  "type",
  "press",
  "keydown",
  "keyup",
  "hover",
  "select",
  "check",
  "uncheck",
  "drag",
  "dialog-accept",
  "dialog-dismiss",
  "resize",
  "go-back",
  "go-forward",
  "reload",
  "mousemove",
  "mousedown",
  "mouseup",
  "mousewheel",
  "tab-list",
  "tab-new",
  "tab-close",
  "tab-select",
  "close",
] as const;

export type PlaywrightCliCommand =
  (typeof PLAYWRIGHT_CLI_COMMANDS)[number];

function isInteger(value: string): boolean {
  return /^-?\d+$/u.test(value);
}

function isRef(value: string): boolean {
  return REF_PATTERN.test(value);
}

function isButton(value: string): boolean {
  return ["left", "right", "middle"].includes(value);
}

function isOpenOption(value: string): boolean {
  return (
    value === "--headed" ||
    value === "--mobile" ||
    value === "--persistent" ||
    /^--browser=(chromium|chrome|msedge|firefox|webkit)$/u.test(value) ||
    /^--device=.{1,128}$/u.test(value) ||
    /^--idle-timeout=\d+$/u.test(value)
  );
}

export function validatePlaywrightCliArgs(
  command: PlaywrightCliCommand,
  args: readonly string[],
): boolean {
  switch (command) {
    case "open": {
      let positional = 0;
      for (const arg of args) {
        if (arg.startsWith("--")) {
          if (!isOpenOption(arg)) return false;
        } else {
          positional += 1;
          if (positional > 1) return false;
        }
      }
      return true;
    }

    case "goto":
      return args.length === 1 && !args[0]!.startsWith("-");

    case "snapshot":
      return (
        args.length <= 3 &&
        args.every(
          (arg) =>
            isRef(arg) ||
            arg === "--boxes" ||
            /^--depth=\d+$/u.test(arg),
        ) &&
        args.filter(isRef).length <= 1
      );

    case "find":
      return (
        (args.length === 1 && args[0]!.length > 0) ||
        (args.length === 2 &&
          args[0] === "--regex" &&
          args[1]!.length > 0)
      );

    case "click":
    case "dblclick":
      return (
        (args.length === 1 && isRef(args[0]!)) ||
        (args.length === 2 &&
          isRef(args[0]!) &&
          isButton(args[1]!))
      );

    case "fill":
      return (
        (args.length === 2 && isRef(args[0]!)) ||
        (args.length === 3 &&
          isRef(args[0]!) &&
          args[2] === "--submit")
      );

    case "type":
      return args.length === 1;

    case "press":
    case "keydown":
    case "keyup":
      return args.length === 1 && args[0]!.length > 0;

    case "hover":
    case "check":
    case "uncheck":
      return args.length === 1 && isRef(args[0]!);

    case "select":
      return args.length === 2 && isRef(args[0]!);

    case "drag":
      return (
        args.length === 2 &&
        isRef(args[0]!) &&
        isRef(args[1]!)
      );

    case "dialog-accept":
      return args.length <= 1;

    case "dialog-dismiss":
    case "go-back":
    case "go-forward":
    case "reload":
    case "tab-list":
    case "close":
      return args.length === 0;

    case "resize":
    case "mousemove":
    case "mousewheel":
      return (
        args.length === 2 &&
        isInteger(args[0]!) &&
        isInteger(args[1]!)
      );

    case "mousedown":
    case "mouseup":
      return (
        args.length === 0 ||
        (args.length === 1 && isButton(args[0]!))
      );

    case "tab-new":
      return (
        args.length === 0 ||
        (args.length === 1 && !args[0]!.startsWith("-"))
      );

    case "tab-close":
      return (
        args.length === 0 ||
        (args.length === 1 && /^\d+$/u.test(args[0]!))
      );

    case "tab-select":
      return args.length === 1 && /^\d+$/u.test(args[0]!);
  }
}

export function playwrightCliCommandArgs(
  session: string,
  command: PlaywrightCliCommand,
  args: readonly string[],
): readonly string[] {
  const prefix = [`-s=${session}`];

  if (command === "snapshot") {
    prefix.push("--raw");
  }

  let commandSpecific = [...args];

  if (
    command === "fill" &&
    args[1]?.startsWith("-")
  ) {
    commandSpecific =
      args[2] === "--submit"
        ? [args[0]!, "--submit", "--", args[1]]
        : [args[0]!, "--", args[1]];
  }

  if (command === "open") {
    if (!commandSpecific.includes("--persistent")) {
      commandSpecific.push("--persistent");
    }

    if (!commandSpecific.includes("--headed")) {
      commandSpecific.push("--headed");
    }
  }

  return [...prefix, command, ...commandSpecific];
}


