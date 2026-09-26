import { ProcessCapability } from "./capabilities/process-capability.js";
import {
  createPnpmCapability,
  resolvePnpmLauncher,
} from "./capabilities/pnpm-capability.js";
import {
  createGitCapability,
  resolveGitLauncher,
} from "./capabilities/git-capability.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import {
  MachineCapabilityStateStore,
  type MachineCapabilityPreferences,
} from "./machine-capability-state-store.js";

const KNOWN_KEYS = ["node", "pnpm", "git"] as const;
type KnownKey = (typeof KNOWN_KEYS)[number];

export interface MachineCapabilityStatus {
  readonly key: KnownKey;
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

export class MachineCapabilityManager {
  readonly #preferences = new Map<KnownKey, boolean>();

  private constructor(
    private readonly registry: CapabilityRegistry,
    private readonly store: MachineCapabilityStateStore,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly nodeExecutable: string,
  ) {}

  static async create(
    registry: CapabilityRegistry,
    store: MachineCapabilityStateStore,
    environment: NodeJS.ProcessEnv = process.env,
    nodeExecutable = process.execPath,
  ): Promise<MachineCapabilityManager> {
    const manager = new MachineCapabilityManager(
      registry,
      store,
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

    manager.#reconcileAll();

    if (persisted === undefined) {
      await manager.#save();
    }

    return manager;
  }

  list(): readonly MachineCapabilityStatus[] {
    return KNOWN_KEYS.map((key) => this.#status(key));
  }

  async setEnabled(
    key: string,
    enabled: boolean,
  ): Promise<MachineCapabilityStatus> {
    if (!this.#isKnownKey(key)) {
      throw new Error(`machine_capability_not_known: ${key}`);
    }

    this.#preferences.set(key, enabled);
    this.#reconcile(key);
    await this.#save();

    return this.#status(key);
  }

  #status(key: KnownKey): MachineCapabilityStatus {
    const enabled = this.#preferences.get(key) ?? true;

    if (key === "node") {
      return {
        key,
        description:
          "Node.js executable. Only --version and -p process.platform are permitted.",
        enabled,
        available: true,
        active: this.registry.has(key),
        launcher: {
          executable: this.nodeExecutable,
          fixedArgs: [],
        },
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
        description:
          "pnpm package-script runner. Allows --version and pnpm run <script>; install/exec/dlx/add are not exposed.",
        enabled,
        available: launcher !== undefined,
        active: this.registry.has(key),
        ...(launcher === undefined ? {} : { launcher }),
        policy: [
          "--version",
          "run <script>",
          "run <script> -- ...scriptArgs",
        ],
      };
    }

    const launcher = resolveGitLauncher(this.environment);

    return {
      key,
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

  #reconcileAll(): void {
    for (const key of KNOWN_KEYS) {
      this.#reconcile(key);
    }
  }

  #reconcile(key: KnownKey): void {
    this.registry.unregister(key);

    if (!(this.#preferences.get(key) ?? true)) {
      return;
    }

    if (key === "node") {
      this.registry.register(
        new ProcessCapability({
          key: "node",
          description:
            "Node.js executable. Only --version and -p process.platform are permitted.",
          executable: this.nodeExecutable,
          allowedArgVectors: [
            ["--version"],
            ["-p", "process.platform"],
          ],
          timeoutMs: 5_000,
          maxOutputBytes: 16 * 1024,
        }),
      );
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
          : createPnpmCapability(launcher);

      if (capability !== undefined) {
        this.registry.register(capability);
      }
      return;
    }

    const launcher = resolveGitLauncher(this.environment);
    const capability =
      launcher === undefined
        ? undefined
        : createGitCapability(launcher);

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

  #isKnownKey(key: string): key is KnownKey {
    return (KNOWN_KEYS as readonly string[]).includes(key);
  }
}
