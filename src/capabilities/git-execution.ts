import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { withoutEnvironmentVariables } from "../execution-environment.js";
import {
  isExistingGitFile,
  type GitLauncher,
} from "./git-launcher.js";
import {
  invocationRemote,
  localGitConfig,
} from "./git-repository.js";
import {
  isSafeGitValue,
} from "./git-policy.js";

interface GitIdentity {
  readonly name?: string;
  readonly email?: string;
}

interface GitNetworkSupport {
  readonly credentialHelper?: string;
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

    return isSafeGitValue(stdout)
      ? stdout
      : undefined;
  } catch {
    return undefined;
  }
}

export function readGlobalGitIdentity(
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

export function resolveGitNetworkSupport(
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
    candidates.find((candidate) => isExistingGitFile(candidate));

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

export function gitExecutionArgs(
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

export function disabledHooksPath(
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
