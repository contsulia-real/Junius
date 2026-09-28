import {
  resolveNodeExecutable,
} from "./capabilities/node-capability.js";
import {
  builtInMachineCapabilityStatus,
  reconcileBuiltInMachineCapability,
} from "./built-in-machine-capabilities.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import {
  discoverPathExecutables,
  type ExecutableCandidate,
} from "./executable-discovery.js";
import {
  customCapabilityAvailable,
  customCapabilityGrantCompatible,
  customCapabilityPolicyLabels,
  createCustomMachineCapability,
  validateCustomMachineCapability,
  type CustomMachineCapabilityDefinition,
} from "./custom-machine-capability.js";
import {
  MachineCapabilityStateStore,
  type MachineCapabilityPreferences,
} from "./machine-capability-state-store.js";

import type { WorkspaceArgumentGrant } from "./workspace-profile.js";
import {
  KNOWN_KEYS,
  workspaceGrantCompatibility,
  type MachineCapabilityKey,
  type WorkspaceGrantCompatibility,
} from "./machine-capability-policy.js";

export type {
  MachineCapabilityKey,
  MachineCapabilityScope,
  WorkspaceGrantCompatibility,
} from "./machine-capability-policy.js";
export type {
  MachineCapabilityServices,
  MachineCapabilityStatus,
} from "./machine-capability-types.js";
import type {
  MachineCapabilityServices,
  MachineCapabilityStatus,
} from "./machine-capability-types.js";
export type {
  CustomMachineCapabilityDefinition,
} from "./custom-machine-capability.js";

function isBuiltInKey(
  key: string,
): key is MachineCapabilityKey {
  return (KNOWN_KEYS as readonly string[])
    .includes(key);
}

export class MachineCapabilityManager {
  readonly #preferences =
    new Map<string, boolean>();
  readonly #customDefinitions =
    new Map<
      string,
      CustomMachineCapabilityDefinition
    >();

  private constructor(
    private readonly registry:
      CapabilityRegistry,
    private readonly store:
      MachineCapabilityStateStore,
    private readonly services:
      MachineCapabilityServices,
    private readonly environment:
      NodeJS.ProcessEnv,
    private readonly nodeExecutable:
      string | undefined,
  ) {}

  static async create(
    registry: CapabilityRegistry,
    store: MachineCapabilityStateStore,
    services: MachineCapabilityServices,
    environment:
      NodeJS.ProcessEnv = process.env,
    nodeExecutable =
      resolveNodeExecutable(environment),
  ): Promise<MachineCapabilityManager> {
    const manager =
      new MachineCapabilityManager(
        registry,
        store,
        services,
        environment,
        nodeExecutable,
      );

    const persisted =
      await store.load();
    manager.#loadPreferences(
      persisted,
    );
    await manager.#reconcileAll();

    if (persisted === undefined) {
      await manager.#save();
    }

    return manager;
  }

  list():
    readonly MachineCapabilityStatus[] {
    const builtIns = KNOWN_KEYS.map(
      (key) => this.#status(key),
    );
    const custom = [
      ...this.#customDefinitions.keys(),
    ]
      .sort((a, b) =>
        a.localeCompare(b),
      )
      .map((key) =>
        this.#status(key),
      );

    return [...builtIns, ...custom];
  }

  discoverExecutables(
    query = "",
    limit = 50,
  ): Promise<readonly ExecutableCandidate[]> {
    return discoverPathExecutables(
      this.environment,
      query,
      limit,
    );
  }

  async reload(): Promise<void> {
    const persisted =
      await this.store.load();
    if (persisted === undefined) {
      throw new Error(
        "machine_capability_state_missing",
      );
    }

    for (
      const key of
      this.#customDefinitions.keys()
    ) {
      this.registry.unregister(key);
    }

    this.#preferences.clear();
    this.#customDefinitions.clear();
    this.#loadPreferences(
      persisted,
    );
    await this.#reconcileAll();
  }

  workspaceGrantCompatibility(
    key: string,
    grant: WorkspaceArgumentGrant,
  ): WorkspaceGrantCompatibility {
    const custom =
      this.#customDefinitions.get(key);
    if (custom !== undefined) {
      return customCapabilityGrantCompatible(
        custom,
        grant,
      )
        ? { valid: true }
        : {
            valid: false,
            reason:
              "arguments_outside_machine_policy",
          };
    }

    return workspaceGrantCompatibility(
      key,
      grant,
    );
  }

  async setEnabled(
    key: string,
    enabled: boolean,
  ): Promise<MachineCapabilityStatus> {
    if (!this.#isKnownKey(key)) {
      throw new Error(
        `machine_capability_not_known: ${key}`,
      );
    }

    this.#preferences.set(
      key,
      enabled,
    );
    await this.#reconcile(key);
    await this.#save();

    return this.#status(key);
  }

  async upsertCustom(
    input: unknown,
  ): Promise<MachineCapabilityStatus> {
    const definition =
      validateCustomMachineCapability(
        input,
      );

    if (isBuiltInKey(definition.key)) {
      throw new Error(
        `custom_machine_capability_reserved_key: ${definition.key}`,
      );
    }

    this.#customDefinitions.set(
      definition.key,
      definition,
    );
    if (
      !this.#preferences.has(
        definition.key,
      )
    ) {
      this.#preferences.set(
        definition.key,
        true,
      );
    }

    await this.#reconcile(
      definition.key,
    );
    await this.#save();

    return this.#status(
      definition.key,
    );
  }

  async removeCustom(
    key: string,
  ): Promise<boolean> {
    if (isBuiltInKey(key)) {
      throw new Error(
        `machine_capability_builtin_not_removable: ${key}`,
      );
    }

    if (
      !this.#customDefinitions.has(key)
    ) {
      return false;
    }

    this.registry.unregister(key);
    this.#customDefinitions.delete(key);
    this.#preferences.delete(key);
    await this.#save();
    return true;
  }

  #loadPreferences(
    persisted:
      MachineCapabilityPreferences |
      undefined,
  ): void {
    for (const key of KNOWN_KEYS) {
      this.#preferences.set(
        key,
        persisted?.[key]?.enabled ??
          true,
      );
    }

    if (persisted === undefined) {
      return;
    }

    for (
      const [key, preference] of
      Object.entries(persisted)
    ) {
      if (
        preference.custom === undefined
      ) {
        continue;
      }

      if (
        isBuiltInKey(key) ||
        preference.custom.key !== key
      ) {
        throw new Error(
          `invalid_custom_machine_capability_key: ${key}`,
        );
      }

      const definition =
        validateCustomMachineCapability(
          preference.custom,
        );
      this.#customDefinitions.set(
        key,
        definition,
      );
      this.#preferences.set(
        key,
        preference.enabled,
      );
    }
  }

  #status(
    key: string,
  ): MachineCapabilityStatus {
    const custom =
      this.#customDefinitions.get(key);
    if (custom !== undefined) {
      const enabled =
        this.#preferences.get(key) ??
        true;
      const available =
        customCapabilityAvailable(
          custom,
        );

      return {
        key,
        scope: "workspace",
        description:
          custom.description,
        enabled,
        available,
        active:
          this.registry.has(key),
        custom: true,
        launcher: {
          executable:
            custom.executable,
          fixedArgs: [
            ...custom.fixedArgs,
          ],
        },
        policy:
          customCapabilityPolicyLabels(
            custom,
          ),
        definition: {
          ...custom,
          fixedArgs: [
            ...custom.fixedArgs,
          ],
          argumentPolicy:
            custom.argumentPolicy
              .map((rule) => ({
                mode: rule.mode,
                args: [...rule.args],
              })),
          environmentPolicy: {
            inherit:
              custom.environmentPolicy
                .inherit,
            allowNames: [
              ...custom.environmentPolicy
                .allowNames,
            ],
            denyNames: [
              ...custom.environmentPolicy
                .denyNames,
            ],
            denyPrefixes: [
              ...custom.environmentPolicy
                .denyPrefixes,
            ],
            set: {
              ...custom.environmentPolicy
                .set,
            },
          },
        },
      };
    }

    if (!isBuiltInKey(key)) {
      throw new Error(
        `machine_capability_not_known: ${key}`,
      );
    }

    return this.#builtInStatus(key);
  }

  #builtInStatus(
    key: MachineCapabilityKey,
  ): MachineCapabilityStatus {
    return builtInMachineCapabilityStatus(
      key,
      this.#preferences.get(key) ?? true,
      {
        registry: this.registry,
        services: this.services,
        environment: this.environment,
        nodeExecutable: this.nodeExecutable,
      },
    );
  }

  async #reconcileAll():
    Promise<void> {
    for (const key of KNOWN_KEYS) {
      await this.#reconcile(key);
    }

    for (
      const key of
      this.#customDefinitions.keys()
    ) {
      await this.#reconcile(key);
    }
  }

  async #reconcile(
    key: string,
  ): Promise<void> {
    const custom =
      this.#customDefinitions.get(key);
    if (custom !== undefined) {
      this.registry.unregister(key);

      if (
        (this.#preferences.get(key) ??
          true) &&
        customCapabilityAvailable(
          custom,
        )
      ) {
        this.registry.register(
          createCustomMachineCapability(
            custom,
            this.environment,
          ),
        );
      }
      return;
    }

    if (!isBuiltInKey(key)) {
      throw new Error(
        `machine_capability_not_known: ${key}`,
      );
    }

    await reconcileBuiltInMachineCapability(
      key,
      this.#preferences.get(key) ?? true,
      {
        registry: this.registry,
        services: this.services,
        environment: this.environment,
        nodeExecutable: this.nodeExecutable,
      },
    );
  }

  #snapshot():
    MachineCapabilityPreferences {
    const snapshot:
      MachineCapabilityPreferences =
      {};

    for (const key of KNOWN_KEYS) {
      snapshot[key] = {
        enabled:
          this.#preferences.get(key) ??
          true,
      };
    }

    for (
      const [key, definition] of
      this.#customDefinitions
    ) {
      snapshot[key] = {
        enabled:
          this.#preferences.get(key) ??
          true,
        custom: definition,
      };
    }

    return snapshot;
  }

  #save(): Promise<void> {
    return this.store.save(
      this.#snapshot(),
    );
  }

  #isKnownKey(
    key: string,
  ): boolean {
    return (
      isBuiltInKey(key) ||
      this.#customDefinitions.has(key)
    );
  }
}
