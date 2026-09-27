import {
  statSync,
} from "node:fs";
import {
  delimiter,
  join,
} from "node:path";
import { ProcessCapability } from "./process-capability.js";

export interface GitLauncher {
  readonly executable: string;
  readonly fixedArgs: readonly string[];
}

const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isSafeValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.includes("\0")
  );
}

function isRemoteUrl(value: string): boolean {
  if (!isSafeValue(value) || value.startsWith("-")) {
    return false;
  }

  return (
    /^https?:\/\//u.test(value) ||
    /^ssh:\/\//u.test(value) ||
    /^git@[^:]+:.+/u.test(value)
  );
}

function isBranch(value: string): boolean {
  return (
    BRANCH_NAME_PATTERN.test(value) &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("..")
  );
}

function isStatusArgs(args: readonly string[]): boolean {
  return args.slice(1).every((arg) =>
    [
      "--short",
      "--branch",
      "--porcelain",
      "--porcelain=v1",
      "--porcelain=v2",
      "--untracked-files=no",
      "--untracked-files=normal",
      "--untracked-files=all",
    ].includes(arg),
  );
}

function isDiffArgs(args: readonly string[]): boolean {
  return args.slice(1).every((arg) =>
    [
      "--cached",
      "--staged",
      "--stat",
      "--name-only",
      "--name-status",
      "--summary",
    ].includes(arg),
  );
}

function isLogArgs(args: readonly string[]): boolean {
  const rest = args.slice(1);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;

    if (
      [
        "--oneline",
        "--decorate",
        "--stat",
        "--name-only",
      ].includes(arg)
    ) {
      continue;
    }

    if (arg === "-n") {
      const count = rest[index + 1];
      if (count === undefined || !/^\d{1,3}$/u.test(count)) {
        return false;
      }
      index += 1;
      continue;
    }

    if (/^-n\d{1,3}$/u.test(arg)) {
      continue;
    }

    return false;
  }

  return true;
}

function isAddArgs(args: readonly string[]): boolean {
  if (args.length < 2) {
    return false;
  }

  const rest = args.slice(1);

  if (
    rest.every((arg) =>
      ["-A", "--all", "-u", "--update", "."].includes(arg),
    )
  ) {
    return true;
  }

  const separator = rest.indexOf("--");
  if (separator < 0 || separator === rest.length - 1) {
    return false;
  }

  return rest
    .slice(separator + 1)
    .every((path) => isSafeValue(path) && !path.startsWith("-"));
}

function isCommitArgs(args: readonly string[]): boolean {
  if (
    args.length === 3 &&
    args[1] === "-m" &&
    isSafeValue(args[2] ?? "")
  ) {
    return true;
  }

  return (
    args.length === 4 &&
    args[1] === "--allow-empty" &&
    args[2] === "-m" &&
    isSafeValue(args[3] ?? "")
  );
}

function isConfigArgs(args: readonly string[]): boolean {
  if (
    args.length === 3 &&
    args[1] === "--get" &&
    ["user.name", "user.email"].includes(args[2] ?? "")
  ) {
    return true;
  }

  return (
    args.length === 4 &&
    args[1] === "--local" &&
    ["user.name", "user.email"].includes(args[2] ?? "") &&
    isSafeValue(args[3] ?? "")
  );
}

function isRemoteArgs(args: readonly string[]): boolean {
  if (args.length === 1) {
    return true;
  }

  if (args.length === 2 && args[1] === "-v") {
    return true;
  }

  if (
    args.length === 3 &&
    args[1] === "get-url" &&
    REMOTE_NAME_PATTERN.test(args[2] ?? "")
  ) {
    return true;
  }

  if (
    args.length === 4 &&
    ["add", "set-url"].includes(args[1] ?? "") &&
    REMOTE_NAME_PATTERN.test(args[2] ?? "") &&
    isRemoteUrl(args[3] ?? "")
  ) {
    return true;
  }

  return (
    args.length === 3 &&
    args[1] === "remove" &&
    REMOTE_NAME_PATTERN.test(args[2] ?? "")
  );
}

function isPushArgs(args: readonly string[]): boolean {
  const rest = args.slice(1);
  const flags: string[] = [];

  while (
    rest.length > 0 &&
    ["--force", "--force-with-lease", "-u", "--set-upstream"].includes(
      rest[0] ?? "",
    )
  ) {
    flags.push(rest.shift()!);
  }

  if (rest.length !== 2) {
    return false;
  }

  const [remote, branch] = rest;

  return (
    REMOTE_NAME_PATTERN.test(remote ?? "") &&
    isBranch(branch ?? "") &&
    new Set(flags).size === flags.length
  );
}

export function isAllowedGitArgs(args: readonly string[]): boolean {
  if (args.length === 1 && args[0] === "--version") {
    return true;
  }

  const command = args[0];

  switch (command) {
    case "init":
      return (
        args.length === 1 ||
        (args.length === 3 &&
          args[1] === "-b" &&
          isBranch(args[2] ?? ""))
      );

    case "status":
      return isStatusArgs(args);

    case "add":
      return isAddArgs(args);

    case "commit":
      return isCommitArgs(args);

    case "config":
      return isConfigArgs(args);

    case "branch":
      return (
        args.length === 1 ||
        (args.length === 2 && args[1] === "--show-current") ||
        (args.length === 3 &&
          ["-M", "-m"].includes(args[1] ?? "") &&
          isBranch(args[2] ?? ""))
      );

    case "remote":
      return isRemoteArgs(args);

    case "fetch":
      return (
        args.length === 1 ||
        (args.length === 2 &&
          REMOTE_NAME_PATTERN.test(args[1] ?? ""))
      );

    case "push":
      return isPushArgs(args);

    case "rev-parse":
      return (
        args.length === 2 &&
        [
          "--is-inside-work-tree",
          "--show-toplevel",
          "HEAD",
        ].includes(args[1] ?? "")
      );

    case "diff":
      return isDiffArgs(args);

    case "log":
      return isLogArgs(args);

    case "ls-files":
      return args.length === 1;

    default:
      return false;
  }
}

function environmentPath(
  environment: NodeJS.ProcessEnv,
): string {
  return (
    environment.PATH ??
    environment.Path ??
    environment.path ??
    ""
  );
}

function candidatePaths(
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  const candidates: string[] = [];

  for (const rawEntry of environmentPath(environment).split(delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/u, "$1");
    if (!entry) continue;

    candidates.push(
      join(entry, "git.exe"),
      join(entry, "git"),
    );
  }

  return candidates;
}

export function resolveGitLauncher(
  environment: NodeJS.ProcessEnv = process.env,
): GitLauncher | undefined {
  for (const candidate of candidatePaths(environment)) {
    if (isFile(candidate)) {
      return {
        executable: candidate,
        fixedArgs: [],
      };
    }
  }

  return undefined;
}

export function createGitCapability(
  launcher: GitLauncher | undefined = resolveGitLauncher(),
): ProcessCapability | undefined {
  if (!launcher) {
    return undefined;
  }

  return new ProcessCapability({
    key: "git",
    description:
      "Git repository operations for Workspace development and synchronization. Destructive clean/reset-hard style operations are not exposed.",
    executable: launcher.executable,
    fixedArgs: launcher.fixedArgs,
    argumentPolicy: isAllowedGitArgs,
    timeoutMs: 300_000,
    maxOutputBytes: 1024 * 1024,
  });
}
