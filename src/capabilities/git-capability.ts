import { ProcessCapability } from "./process-capability.js";
import {
  isAllowedGitArgs,
} from "./git-policy.js";
import {
  resolveGitLauncher,
  type GitLauncher,
} from "./git-launcher.js";
import {
  disabledHooksPath,
  gitExecutionArgs,
  readGlobalGitIdentity,
  resolveGitNetworkSupport,
} from "./git-execution.js";
import {
  gitRepositoryPreflight,
} from "./git-repository.js";

export {
  isAllowedGitArgs,
} from "./git-policy.js";
export {
  resolveGitLauncher,
  type GitLauncher,
} from "./git-launcher.js";

export function createGitCapability(
  launcher: GitLauncher | undefined =
    resolveGitLauncher(),
  environment: NodeJS.ProcessEnv =
    process.env,
): ProcessCapability | undefined {
  if (!launcher) {
    return undefined;
  }

  const hooksPath =
    disabledHooksPath(environment);
  const globalIdentity =
    readGlobalGitIdentity(
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
    fixedArgsForExecution: (
      args,
      context,
    ) =>
      gitExecutionArgs(
        args,
        context.cwd,
        globalIdentity,
        networkSupport,
      ),
    argumentPolicy: isAllowedGitArgs,
    preflight: (args, context) =>
      gitRepositoryPreflight(
        args,
        context.cwd,
      ),
    timeoutMs: 300_000,
    maxOutputBytes: 1024 * 1024,
    inheritedEnvironment:
      environment,
    inheritedEnvironmentDenyPrefixes: [
      "GIT_",
    ],
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
