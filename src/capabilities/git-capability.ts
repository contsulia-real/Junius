import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { withoutEnvironmentVariables } from "../execution-environment.js";
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
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isRemoteUrl(value: string): boolean {
  if (
    !isSafeValue(value) ||
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
        args.length === 2 &&
        REMOTE_NAME_PATTERN.test(args[1] ?? "")
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

const MAX_LOCAL_CONFIG_BYTES = 512 * 1024;

interface ParsedLocalGitConfig {
  readonly remotes: Map<
    string,
    {
      readonly urls: string[];
      readonly pushUrls: string[];
    }
  >;
  readonly userName?: string;
  readonly userEmail?: string;
}

interface GitIdentity {
  readonly name?: string;
  readonly email?: string;
}

interface GitNetworkSupport {
  readonly credentialHelper?: string;
}

function pathInside(
  root: string,
  candidate: string,
): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (
      rel !== ".." &&
      !rel.startsWith(`..${sep}`) &&
      !isAbsolute(rel)
    )
  );
}

function unsafeConfig(
  message: string,
) {
  return {
    ok: false as const,
    code: "unsafe_repository_config" as const,
    message,
  };
}

function decodeConfigValue(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) {
    return "true";
  }

  let value = raw.trim();
  if (value.startsWith('"')) {
    if (
      value.length < 2 ||
      !value.endsWith('"')
    ) {
      return undefined;
    }

    value = value.slice(1, -1);
    value = value.replace(
      /\\(["\\ntb])/gu,
      (_match, escaped: string) => {
        switch (escaped) {
          case "n":
            return "\n";
          case "t":
            return "\t";
          case "b":
            return "\b";
          default:
            return escaped;
        }
      },
    );
  } else {
    value = value.replace(
      /\s+[;#].*$/u,
      "",
    ).trim();
  }

  return isSafeValue(value) ? value : undefined;
}

function parseLocalGitConfig(
  text: string,
): ParsedLocalGitConfig | undefined {
  const remotes = new Map<
    string,
    { urls: string[]; pushUrls: string[] }
  >();
  let userName: string | undefined;
  let userEmail: string | undefined;
  let section:
    | {
        readonly name: string;
        readonly subsection?: string;
      }
    | undefined;

  const allowedCore = new Set([
    "repositoryformatversion",
    "filemode",
    "bare",
    "logallrefupdates",
    "ignorecase",
    "symlinks",
    "precomposeunicode",
  ]);
  const allowedBranch = new Set([
    "remote",
    "merge",
    "vscode-merge-base",
  ]);
  const allowedRemote = new Set([
    "url",
    "pushurl",
    "fetch",
  ]);
  const allowedUser = new Set([
    "name",
    "email",
  ]);

  for (const sourceLine of text.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (
      line === "" ||
      line.startsWith("#") ||
      line.startsWith(";")
    ) {
      continue;
    }

    if (/\\\s*$/u.test(line)) {
      return undefined;
    }

    const sectionMatch = line.match(
      /^\[([A-Za-z0-9.-]+)(?:\s+"([^"]+)")?\]$/u,
    );
    if (sectionMatch !== null) {
      section = {
        name: sectionMatch[1]!.toLowerCase(),
        ...(sectionMatch[2] === undefined
          ? {}
          : { subsection: sectionMatch[2] }),
      };
      continue;
    }

    if (section === undefined) {
      return undefined;
    }

    const keyMatch = line.match(
      /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/u,
    );
    if (keyMatch === null) {
      return undefined;
    }

    const key = keyMatch[1]!.toLowerCase();
    const value = decodeConfigValue(
      keyMatch[2],
    );
    if (value === undefined) {
      return undefined;
    }

    if (
      section.name === "core" &&
      section.subsection === undefined &&
      allowedCore.has(key)
    ) {
      continue;
    }

    if (
      section.name === "user" &&
      section.subsection === undefined &&
      allowedUser.has(key)
    ) {
      if (key === "name") {
        userName = value;
      } else if (key === "email") {
        userEmail = value;
      }
      continue;
    }

    if (
      section.name === "branch" &&
      section.subsection !== undefined &&
      isBranch(section.subsection) &&
      allowedBranch.has(key)
    ) {
      continue;
    }

    if (
      section.name === "remote" &&
      section.subsection !== undefined &&
      REMOTE_NAME_PATTERN.test(
        section.subsection,
      ) &&
      allowedRemote.has(key)
    ) {
      const remote =
        remotes.get(section.subsection) ?? {
          urls: [],
          pushUrls: [],
        };
      if (key === "url") {
        remote.urls.push(value);
      } else if (key === "pushurl") {
        remote.pushUrls.push(value);
      }
      remotes.set(section.subsection, remote);
      continue;
    }

    return undefined;
  }

  return {
    remotes,
    ...(userName === undefined
      ? {}
      : { userName }),
    ...(userEmail === undefined
      ? {}
      : { userEmail }),
  };
}

function readGlobalGitIdentityValue(
  launcher: GitLauncher,
  environment: NodeJS.ProcessEnv,
  key: "user.name" | "user.email",
): string | undefined {
  const sanitized = withoutEnvironmentVariables(
    environment,
    {
      prefixes: ["GIT_"],
      names: [
        "SSH_ASKPASS",
        "SSH_ASKPASS_REQUIRE",
      ],
    },
  );

  try {
    const stdout = execFileSync(
      launcher.executable,
      [
        ...launcher.fixedArgs,
        "config",
        "--global",
        "--get",
        key,
      ],
      {
        encoding: "utf8",
        env: {
          ...sanitized,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never",
        },
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).replace(/\r?\n$/u, "");

    return isSafeValue(stdout)
      ? stdout
      : undefined;
  } catch {
    return undefined;
  }
}

function readGlobalGitIdentity(
  launcher: GitLauncher,
  environment: NodeJS.ProcessEnv,
): GitIdentity {
  const name = readGlobalGitIdentityValue(
    launcher,
    environment,
    "user.name",
  );
  const email = readGlobalGitIdentityValue(
    launcher,
    environment,
    "user.email",
  );

  return {
    ...(name === undefined ? {} : { name }),
    ...(email === undefined ? {} : { email }),
  };
}

function gitIdentityArgs(
  cwd: string,
  globalIdentity: GitIdentity,
): readonly string[] {
  const local = localGitConfig(cwd);
  if (local === undefined) {
    return [];
  }

  const name = local.userName ?? globalIdentity.name;
  const email =
    local.userEmail ?? globalIdentity.email;
  const args: string[] = [];

  if (name !== undefined) {
    args.push("-c", `user.name=${name}`);
  }
  if (email !== undefined) {
    args.push("-c", `user.email=${email}`);
  }

  return args;
}

function resolveGitNetworkSupport(
  launcher: GitLauncher,
): GitNetworkSupport {
  if (process.platform !== "win32") {
    return {};
  }

  const installRoot = resolve(
    dirname(launcher.executable),
    "..",
  );
  const candidates = [
    join(
      installRoot,
      "mingw64",
      "bin",
      "git-credential-manager.exe",
    ),
    join(
      installRoot,
      "mingw32",
      "bin",
      "git-credential-manager.exe",
    ),
    join(
      installRoot,
      "cmd",
      "git-credential-manager.exe",
    ),
    join(
      installRoot,
      "bin",
      "git-credential-manager.exe",
    ),
  ];
  const credentialHelper =
    candidates.find((candidate) => isFile(candidate));

  return credentialHelper === undefined
    ? {}
    : {
        credentialHelper:
          credentialHelper.replaceAll("\\", "/"),
      };
}

function gitNetworkArgs(
  args: readonly string[],
  cwd: string,
  support: GitNetworkSupport,
): readonly string[] {
  if (process.platform !== "win32") {
    return [];
  }

  const target = invocationRemote(args);
  if (target === undefined) {
    return [];
  }

  const config = localGitConfig(cwd);
  if (config === undefined) {
    return [];
  }

  const remote = config.remotes.get(target.remote);
  const urls =
    target.push &&
    (remote?.pushUrls.length ?? 0) > 0
      ? remote!.pushUrls
      : remote?.urls ?? [];
  const usesHttp = urls.some((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "http:" ||
        url.protocol === "https:"
      );
    } catch {
      return false;
    }
  });

  if (!usesHttp) {
    return [];
  }

  return [
    "-c",
    "http.sslBackend=openssl",
    ...(support.credentialHelper === undefined
      ? []
      : [
          "-c",
          `credential.helper=${support.credentialHelper}`,
        ]),
  ];
}

function gitExecutionArgs(
  args: readonly string[],
  cwd: string,
  globalIdentity: GitIdentity,
  networkSupport: GitNetworkSupport,
): readonly string[] {
  return [
    ...gitIdentityArgs(cwd, globalIdentity),
    ...gitNetworkArgs(
      args,
      cwd,
      networkSupport,
    ),
  ];
}

function gitMetadataRoot(
  cwd: string,
): string | undefined {
  const dotGit = join(cwd, ".git");
  let info;
  try {
    info = lstatSync(dotGit);
  } catch {
    return undefined;
  }

  if (
    info.isSymbolicLink() ||
    !info.isDirectory()
  ) {
    return undefined;
  }

  const canonical = realpathSync(dotGit);
  return pathInside(cwd, canonical)
    ? canonical
    : undefined;
}

function localGitConfig(
  cwd: string,
): ParsedLocalGitConfig | undefined {
  const gitRoot = gitMetadataRoot(cwd);
  if (gitRoot === undefined) {
    return undefined;
  }

  const files = [
    join(gitRoot, "config"),
    join(gitRoot, "config.worktree"),
  ];
  let combined = "";

  for (const file of files) {
    try {
      const info = statSync(file);
      if (
        !info.isFile() ||
        info.size > MAX_LOCAL_CONFIG_BYTES
      ) {
        return undefined;
      }
      combined +=
        readFileSync(file, "utf8") + "\n";
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      return undefined;
    }
  }

  return parseLocalGitConfig(combined);
}

function invocationRemote(
  args: readonly string[],
): {
  readonly remote: string;
  readonly push: boolean;
} | undefined {
  if (
    args[0] === "fetch" &&
    args.length === 2
  ) {
    return {
      remote: args[1]!,
      push: false,
    };
  }

  if (args[0] !== "push") {
    return undefined;
  }

  const rest = [...args.slice(1)];
  while (
    rest.length > 0 &&
    ["--force", "--force-with-lease", "-u", "--set-upstream"].includes(
      rest[0]!,
    )
  ) {
    rest.shift();
  }

  if (rest.length !== 2) {
    return undefined;
  }

  return {
    remote: rest[0]!,
    push: true,
  };
}

function gitRepositoryPreflight(
  args: readonly string[],
  cwd: string,
) {
  if (
    (args.length === 1 &&
      args[0] === "--version") ||
    args[0] === "init"
  ) {
    return { ok: true as const };
  }

  const config = localGitConfig(cwd);
  if (config === undefined) {
    return unsafeConfig(
      "Git repository metadata/config must be self-contained inside the Workspace and use only safe local config keys.",
    );
  }

  const target = invocationRemote(args);
  if (target === undefined) {
    return { ok: true as const };
  }

  const remote = config.remotes.get(
    target.remote,
  );
  const urls =
    target.push &&
    (remote?.pushUrls.length ?? 0) > 0
      ? remote!.pushUrls
      : remote?.urls ?? [];

  if (
    urls.length === 0 ||
    urls.some((url) => !isRemoteUrl(url))
  ) {
    return unsafeConfig(
      `Git remote ${target.remote} is missing or uses an unsafe URL.`,
    );
  }

  return { ok: true as const };
}

function disabledHooksPath(
  environment: NodeJS.ProcessEnv,
): string {
  if (process.platform === "win32") {
    const localAppData =
      environment.LOCALAPPDATA ??
      join(homedir(), "AppData", "Local");
    return join(
      localAppData,
      "Junius",
      "disabled-git-hooks",
    );
  }

  const stateRoot =
    environment.XDG_STATE_HOME ??
    join(homedir(), ".local", "state");
  return join(
    stateRoot,
    "Junius",
    "disabled-git-hooks",
  );
}

export function createGitCapability(
  launcher: GitLauncher | undefined = resolveGitLauncher(),
  environment: NodeJS.ProcessEnv = process.env,
): ProcessCapability | undefined {
  if (!launcher) {
    return undefined;
  }

  const hooksPath = disabledHooksPath(environment);
  const globalIdentity = readGlobalGitIdentity(
    launcher,
    environment,
  );
  const networkSupport =
    resolveGitNetworkSupport(launcher);

  return new ProcessCapability({
    key: "git",
    description:
      "Git repository operations for Workspace development and synchronization. Destructive clean/reset-hard style operations are not exposed.",
    executable: launcher.executable,
    fixedArgs: [
      ...launcher.fixedArgs,
      "--no-pager",
      "-c",
      `core.hooksPath=${hooksPath}`,
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.pager=",
    ],
    fixedArgsForExecution: (args, context) =>
      gitExecutionArgs(
        args,
        context.cwd,
        globalIdentity,
        networkSupport,
      ),
    argumentPolicy: isAllowedGitArgs,
    preflight: (_args, context) =>
      gitRepositoryPreflight(
        _args,
        context.cwd,
      ),
    timeoutMs: 300_000,
    maxOutputBytes: 1024 * 1024,
    inheritedEnvironment: environment,
    inheritedEnvironmentDenyPrefixes: ["GIT_"],
    inheritedEnvironmentDenyNames: [
      "SSH_ASKPASS",
      "SSH_ASKPASS_REQUIRE",
    ],
    environment: {
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL:
        process.platform === "win32"
          ? "NUL"
          : "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
    },
  });
}
