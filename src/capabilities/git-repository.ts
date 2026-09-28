import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";
import {
  GIT_REMOTE_NAME_PATTERN,
  isSafeGitBranch,
  isSafeGitRemoteUrl,
  isSafeGitValue,
} from "./git-policy.js";

const MAX_LOCAL_CONFIG_BYTES = 512 * 1024;

export interface ParsedLocalGitConfig {
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

  return isSafeGitValue(value) ? value : undefined;
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
      isSafeGitBranch(section.subsection) &&
      allowedBranch.has(key)
    ) {
      continue;
    }

    if (
      section.name === "remote" &&
      section.subsection !== undefined &&
      GIT_REMOTE_NAME_PATTERN.test(
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

export function localGitConfig(
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

export function invocationRemote(
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

export function gitRepositoryPreflight(
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
    urls.some((url) => !isSafeGitRemoteUrl(url))
  ) {
    return unsafeConfig(
      `Git remote ${target.remote} is missing or uses an unsafe URL.`,
    );
  }

  return { ok: true as const };
}
