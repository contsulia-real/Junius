import {
  createNodeCapability,
} from "./capabilities/node-capability.js";
import {
  createPnpmCapability,
  resolvePnpmLauncher,
} from "./capabilities/pnpm-capability.js";
import {
  createGitCapability,
  resolveGitLauncher,
} from "./capabilities/git-capability.js";
import type { CapabilityRegistry } from "./capabilities/registry.js";
import {
  PLAYWRIGHT_CLI_COMMANDS,
} from "./playwright-cli.js";
import {
  DESKTOP_COMMANDS,
} from "./desktop-computer-use.js";
import type {
  MachineCapabilityKey,
} from "./machine-capability-policy.js";
import type {
  MachineCapabilityServices,
  MachineCapabilityStatus,
} from "./machine-capability-types.js";

export interface BuiltInMachineCapabilityContext {
  readonly registry: CapabilityRegistry;
  readonly services: MachineCapabilityServices;
  readonly environment: NodeJS.ProcessEnv;
  readonly nodeExecutable: string | undefined;
}

export function builtInMachineCapabilityStatus(
  key: MachineCapabilityKey,
  enabled: boolean,
  context: BuiltInMachineCapabilityContext,
): MachineCapabilityStatus {
  if (key === "node") {
    return {
      key,
      scope: "workspace",
      description:
        "Node.js executable resolved from PATH. Only --version and -p process.platform are permitted.",
      enabled,
      available:
        context.nodeExecutable !== undefined,
      active:
        context.registry.has(key),
      custom: false,
      ...(context.nodeExecutable === undefined
        ? {}
        : {
            launcher: {
              executable:
                context.nodeExecutable,
              fixedArgs: [],
            },
          }),
      policy: [
        "--version",
        "-p process.platform",
      ],
    };
  }

  if (key === "pnpm") {
    const launcher =
      resolvePnpmLauncher(
        context.environment,
        context.nodeExecutable,
      );

    return {
      key,
      scope: "workspace",
      description:
        "pnpm Workspace package manager and script runner. Allows selected script shortcuts, install/update/self-update/add, and pnpm run <script>; exec/dlx remain blocked.",
      enabled,
      available:
        launcher !== undefined,
      active:
        context.registry.has(key),
      custom: false,
      ...(launcher === undefined
        ? {}
        : { launcher }),
      policy: [
        "--version",
        "typecheck",
        "lint",
        "test",
        "build",
        "install [...args]",
        "update [...packages/options]",
        "self-update [version]",
        "add <pkg...> [...options]",
        "run <script>",
        "run <script> -- ...scriptArgs",
      ],
    };
  }

  if (key === "git") {
    const launcher =
      resolveGitLauncher(
        context.environment,
      );

    return {
      key,
      scope: "workspace",
      description:
        "Git repository operations for Workspace development and synchronization. Destructive clean/reset-hard style operations are not exposed.",
      enabled,
      available:
        launcher !== undefined,
      active:
        context.registry.has(key),
      custom: false,
      ...(launcher === undefined
        ? {}
        : { launcher }),
      policy: [
        "--version",
        "init [-b <branch>]",
        "status",
        "add",
        "commit -m <message>",
        "config --local user.name/user.email",
        "branch",
        "remote",
        "fetch",
        "push [--force|--force-with-lease] [-u|--set-upstream] <remote> <branch>",
        "rev-parse",
        "diff",
        "log",
        "ls-files",
      ],
    };
  }

  if (key === "browser") {
    return {
      key,
      scope: "machine",
      description:
        "Local headed browser computer use through the bounded playwright-cli adapter.",
      enabled,
      available:
        context.services.browser.available,
      active:
        context.services.browser.active,
      custom: false,
      policy:
        PLAYWRIGHT_CLI_COMMANDS,
    };
  }

  return {
    key,
    scope: "machine",
    description:
      "Local Windows desktop computer use through screenshots plus bounded mouse and keyboard actions.",
    enabled,
    available:
      context.services.desktop.available,
    active:
      context.services.desktop.active,
    custom: false,
    policy: DESKTOP_COMMANDS,
  };
}

export async function reconcileBuiltInMachineCapability(
  key: MachineCapabilityKey,
  enabled: boolean,
  context: BuiltInMachineCapabilityContext,
): Promise<void> {
  if (key === "browser") {
    await context.services.browser
      .setEnabled(enabled);
    return;
  }

  if (key === "desktop") {
    await context.services.desktop
      .setEnabled(enabled);
    return;
  }

  context.registry.unregister(key);
  if (!enabled) {
    return;
  }

  if (key === "node") {
    const capability =
      context.nodeExecutable === undefined
        ? undefined
        : createNodeCapability(
            {
              executable:
                context.nodeExecutable,
              fixedArgs: [],
            },
            context.environment,
          );
    if (capability !== undefined) {
      context.registry.register(capability);
    }
    return;
  }

  if (key === "pnpm") {
    const launcher =
      resolvePnpmLauncher(
        context.environment,
        context.nodeExecutable,
      );
    const capability =
      launcher === undefined
        ? undefined
        : createPnpmCapability(
            launcher,
            context.environment,
          );
    if (capability !== undefined) {
      context.registry.register(capability);
    }
    return;
  }

  const launcher =
    resolveGitLauncher(
      context.environment,
    );
  const capability =
    launcher === undefined
      ? undefined
      : createGitCapability(
          launcher,
          context.environment,
        );
  if (capability !== undefined) {
    context.registry.register(capability);
  }
}
