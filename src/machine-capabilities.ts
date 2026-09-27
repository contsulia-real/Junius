import {
  createNodeCapability,
  resolveNodeExecutable,
} from "./capabilities/node-capability.js";
import {
  createPnpmCapability,
  isAllowedPnpmArgs,
  resolvePnpmLauncher,
} from "./capabilities/pnpm-capability.js";
import {
  createGitCapability,
  isAllowedGitArgs,
  resolveGitLauncher,
} from "./capabilities/git-capability.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import {
  MachineCapabilityStateStore,
  type MachineCapabilityPreferences,
} from "./machine-capability-state-store.js";
import {
  PLAYWRIGHT_CLI_COMMANDS,
  PlaywrightCliService,
} from "./playwright-cli.js";
import {
  DESKTOP_COMMANDS,
  DesktopComputerUseService,
} from "./desktop-computer-use.js";
import type { WorkspaceArgumentGrant } from "./workspace-profile.js";

const KNOWN_KEYS = [
  "node",
  "pnpm",
  "git",
  "browser",
  "desktop",
] as const;

export type MachineCapabilityKey = (typeof KNOWN_KEYS)[number];
export type MachineCapabilityScope = "workspace" | "machine";

const NODE_ALLOWED_ARGUMENTS = [
  ["--version"],
  ["-p", "process.platform"],
] as const;

function startsWith(
  value: readonly string[],
  prefix: readonly string[],
): boolean {
  return (
    prefix.length <= value.length &&
    prefix.every((part, index) => value[index] === part)
  );
}

function nodeGrantCompatible(grant: WorkspaceArgumentGrant): boolean {
  if (grant.mode === "exact") {
    return NODE_ALLOWED_ARGUMENTS.some(
      (allowed) =>
        allowed.length === grant.args.length &&
        startsWith(allowed, grant.args),
    );
  }

  return (
    grant.args.length > 0 &&
    NODE_ALLOWED_ARGUMENTS.some((allowed) =>
      startsWith(allowed, grant.args),
    )
  );
}

function pnpmGrantCompatible(grant: WorkspaceArgumentGrant): boolean {
  if (grant.mode === "exact") {
    return isAllowedPnpmArgs(grant.args);
  }

  const args = grant.args;
  if (args.length === 0) return false;
  if (isAllowedPnpmArgs(args)) return true;

  if (args.length === 1 && (args[0] === "run" || args[0] === "add")) {
    return true;
  }

  if (args[0] !== "run") return false;
  if (args.length < 2) return false;

  const script = args[1] ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(script)) {
    return false;
  }

  if (args.length === 2) return true;
  return args[2] === "--";
}

function gitGrantCompatible(grant: WorkspaceArgumentGrant): boolean {
  if (grant.mode === "exact") {
    return isAllowedGitArgs(grant.args);
  }

  const args = grant.args;
  if (args.length === 0) return false;
  if (isAllowedGitArgs(args)) return true;

  const witnesses: readonly (readonly string[])[] = [
    ["--version"],
    ["init"],
    ["init", "-b", "main"],
    ["status"],
    ["status", "--short"],
    ["add", "-A"],
    ["add", "--", "README.md"],
    ["commit", "-m", "message"],
    ["commit", "--allow-empty", "-m", "message"],
    ["config", "--get", "user.name"],
    ["config", "--local", "user.name", "Junius"],
    ["branch"],
    ["branch", "--show-current"],
    ["branch", "-M", "main"],
    ["remote"],
    ["remote", "-v"],
    ["remote", "get-url", "origin"],
    ["remote", "add", "origin", "https://example.invalid/repo.git"],
    ["remote", "set-url", "origin", "https://example.invalid/repo.git"],
    ["remote", "remove", "origin"],
    ["fetch"],
    ["fetch", "origin"],
    ["push", "origin", "main"],
    ["push", "--force", "origin", "main"],
    ["push", "-u", "origin", "main"],
    ["push", "--force", "-u", "origin", "main"],
    ["rev-parse", "HEAD"],
    ["diff"],
    ["diff", "--cached"],
    ["log"],
    ["log", "-n", "1"],
    ["ls-files"],
  ];

  return witnesses.some((witness) => startsWith(witness, args));
}

export interface WorkspaceGrantCompatibility {
  readonly valid: boolean;
  readonly reason?:
    | "machine_capability_not_known"
    | "capability_not_workspace_scoped"
    | "arguments_outside_machine_policy";
}

export interface MachineCapabilityStatus {
  readonly key: MachineCapabilityKey;
  readonly scope: MachineCapabilityScope;
  readonly description: string;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly active: boolean;
  readonly launcher?: {
    readonly executable: string;
    readonly fixedArgs: readonly string[];
  };
  readonly policy: readonly string[];
}

export interface MachineCapabilityServices {
  readonly browser: PlaywrightCliService;
  readonly desktop: DesktopComputerUseService;
}

export class MachineCapabilityManager {
  readonly #preferences = new Map<MachineCapabilityKey, boolean>();

  private constructor(
    private readonly registry: CapabilityRegistry,
    private readonly store: MachineCapabilityStateStore,
    private readonly services: MachineCapabilityServices,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly nodeExecutable: string | undefined,
  ) {}

  static async create(
    registry: CapabilityRegistry,
    store: MachineCapabilityStateStore,
    services: MachineCapabilityServices,
    environment: NodeJS.ProcessEnv = process.env,
    nodeExecutable = resolveNodeExecutable(environment),
  ): Promise<MachineCapabilityManager> {
    const manager = new MachineCapabilityManager(
      registry,
      store,
      services,
      environment,
      nodeExecutable,
    );

    const persisted = await store.load();

    for (const key of KNOWN_KEYS) {
      manager.#preferences.set(
        key,
        persisted?.[key]?.enabled ?? true,
      );
    }

    await manager.#reconcileAll();

    if (persisted === undefined) {
      await manager.#save();
    }

    return manager;
  }

  list(): readonly MachineCapabilityStatus[] {
    return KNOWN_KEYS.map((key) => this.#status(key));
  }

  async reload(): Promise<void> {
    const persisted = await this.store.load();
    if (persisted === undefined) {
      throw new Error("machine_capability_state_missing");
    }

    for (const key of KNOWN_KEYS) {
      this.#preferences.set(
        key,
        persisted[key]?.enabled ?? true,
      );
    }

    await this.#reconcileAll();
  }

  workspaceGrantCompatibility(
    key: string,
    grant: WorkspaceArgumentGrant,
  ): WorkspaceGrantCompatibility {
    if (!this.#isKnownKey(key)) {
      return {
        valid: false,
        reason: "machine_capability_not_known",
      };
    }

    if (key === "browser" || key === "desktop") {
      return {
        valid: false,
        reason: "capability_not_workspace_scoped",
      };
    }

    const valid =
      key === "node"
        ? nodeGrantCompatible(grant)
        : key === "pnpm"
          ? pnpmGrantCompatible(grant)
          : gitGrantCompatible(grant);

    return valid
      ? { valid: true }
      : {
          valid: false,
          reason: "arguments_outside_machine_policy",
        };
  }

  async setEnabled(
    key: string,
    enabled: boolean,
  ): Promise<MachineCapabilityStatus> {
    if (!this.#isKnownKey(key)) {
      throw new Error(`machine_capability_not_known: ${key}`);
    }

    this.#preferences.set(key, enabled);
    await this.#reconcile(key);
    await this.#save();

    return this.#status(key);
  }

  #status(key: MachineCapabilityKey): MachineCapabilityStatus {
    const enabled = this.#preferences.get(key) ?? true;

    if (key === "node") {
      return {
        key,
        scope: "workspace",
        description:
          "Node.js executable resolved from PATH. Only --version and -p process.platform are permitted.",
        enabled,
        available: this.nodeExecutable !== undefined,
        active: this.registry.has(key),
        ...(this.nodeExecutable === undefined
          ? {}
          : {
              launcher: {
                executable: this.nodeExecutable,
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
      const launcher = resolvePnpmLauncher(
        this.environment,
        this.nodeExecutable,
      );

      return {
        key,
        scope: "workspace",
        description:
          "pnpm Workspace package manager and script runner. Allows selected script shortcuts, install/update/self-update/add, and pnpm run <script>; exec/dlx remain blocked.",
        enabled,
        available: launcher !== undefined,
        active: this.registry.has(key),
        ...(launcher === undefined ? {} : { launcher }),
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
      const launcher = resolveGitLauncher(this.environment);

      return {
        key,
        scope: "workspace",
        description:
          "Git repository operations for Workspace development and synchronization. Destructive clean/reset-hard style operations are not exposed.",
        enabled,
        available: launcher !== undefined,
        active: this.registry.has(key),
        ...(launcher === undefined ? {} : { launcher }),
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
        available: this.services.browser.available,
        active: this.services.browser.active,
        policy: PLAYWRIGHT_CLI_COMMANDS,
      };
    }

    return {
      key,
      scope: "machine",
      description:
        "Local Windows desktop computer use through UI Automation plus bounded screenshot, mouse, and keyboard actions.",
      enabled,
      available: this.services.desktop.available,
      active: this.services.desktop.active,
      policy: DESKTOP_COMMANDS,
    };
  }

  async #reconcileAll(): Promise<void> {
    for (const key of KNOWN_KEYS) {
      await this.#reconcile(key);
    }
  }

  async #reconcile(
    key: MachineCapabilityKey,
  ): Promise<void> {
    const enabled = this.#preferences.get(key) ?? true;

    if (key === "browser") {
      await this.services.browser.setEnabled(enabled);
      return;
    }

    if (key === "desktop") {
      await this.services.desktop.setEnabled(enabled);
      return;
    }

    this.registry.unregister(key);

    if (!enabled) {
      return;
    }

    if (key === "node") {
      const capability =
        this.nodeExecutable === undefined
          ? undefined
          : createNodeCapability(
              {
                executable: this.nodeExecutable,
                fixedArgs: [],
              },
              this.environment,
            );

      if (capability !== undefined) {
        this.registry.register(capability);
      }
      return;
    }

    if (key === "pnpm") {
      const launcher = resolvePnpmLauncher(
        this.environment,
        this.nodeExecutable,
      );
      const capability =
        launcher === undefined
          ? undefined
          : createPnpmCapability(
              launcher,
              this.environment,
            );

      if (capability !== undefined) {
        this.registry.register(capability);
      }
      return;
    }

    const launcher = resolveGitLauncher(this.environment);
    const capability =
      launcher === undefined
        ? undefined
        : createGitCapability(
            launcher,
            this.environment,
          );

    if (capability !== undefined) {
      this.registry.register(capability);
    }
  }

  #snapshot(): MachineCapabilityPreferences {
    return Object.fromEntries(
      KNOWN_KEYS.map((key) => [
        key,
        {
          enabled: this.#preferences.get(key) ?? true,
        },
      ]),
    );
  }

  #save(): Promise<void> {
    return this.store.save(this.#snapshot());
  }

  #isKnownKey(key: string): key is MachineCapabilityKey {
    return (KNOWN_KEYS as readonly string[]).includes(key);
  }
}
