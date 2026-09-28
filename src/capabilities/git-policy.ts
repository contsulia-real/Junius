export const GIT_REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

export function isSafeGitValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function isSafeGitRemoteUrl(value: string): boolean {
  if (
    !isSafeGitValue(value) ||
    value.startsWith("-") ||
    /\s/u.test(value)
  ) {
    return false;
  }

  if (
    /^git@[A-Za-z0-9.-]+:[^\s]+$/u.test(value)
  ) {
    return true;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return (
    ["http:", "https:", "ssh:"].includes(
      url.protocol,
    ) &&
    /^[A-Za-z0-9.-]+$/u.test(url.hostname) &&
    url.hostname.length > 0
  );
}

export function isSafeGitBranch(value: string): boolean {
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
    .every((path) => isSafeGitValue(path) && !path.startsWith("-"));
}

function isCommitArgs(args: readonly string[]): boolean {
  if (
    args.length === 3 &&
    args[1] === "-m" &&
    isSafeGitValue(args[2] ?? "")
  ) {
    return true;
  }

  return (
    args.length === 4 &&
    args[1] === "--allow-empty" &&
    args[2] === "-m" &&
    isSafeGitValue(args[3] ?? "")
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
    isSafeGitValue(args[3] ?? "")
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
    GIT_REMOTE_NAME_PATTERN.test(args[2] ?? "")
  ) {
    return true;
  }

  if (
    args.length === 4 &&
    ["add", "set-url"].includes(args[1] ?? "") &&
    GIT_REMOTE_NAME_PATTERN.test(args[2] ?? "") &&
    isSafeGitRemoteUrl(args[3] ?? "")
  ) {
    return true;
  }

  return (
    args.length === 3 &&
    args[1] === "remove" &&
    GIT_REMOTE_NAME_PATTERN.test(args[2] ?? "")
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
    GIT_REMOTE_NAME_PATTERN.test(remote ?? "") &&
    isSafeGitBranch(branch ?? "") &&
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
          isSafeGitBranch(args[2] ?? ""))
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
          isSafeGitBranch(args[2] ?? ""))
      );

    case "remote":
      return isRemoteArgs(args);

    case "fetch":
      return (
        args.length === 2 &&
        GIT_REMOTE_NAME_PATTERN.test(args[1] ?? "")
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

