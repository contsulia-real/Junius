import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  customMachineCapabilityDefinitionSchema,
  legacyCustomMachineCapabilityDefinitionSchema,
  legacyCustomMachineCapabilityEnvironment,
  type CustomMachineCapabilityDefinition,
} from "./custom-machine-capability.js";

const enabledPreferenceSchema = z.object({
  enabled: z.boolean(),
});

const v1Schema = z.object({
  version: z.literal(1),
  capabilities: z.record(
    z.string().min(1),
    enabledPreferenceSchema,
  ),
});

const v2Schema = z.object({
  version: z.literal(2),
  capabilities: z.record(
    z.string().min(1),
    z.object({
      enabled: z.boolean(),
      custom:
        legacyCustomMachineCapabilityDefinitionSchema
          .optional(),
    }),
  ),
});

const v3Schema = z.object({
  version: z.literal(3),
  capabilities: z.record(
    z.string().min(1),
    z.object({
      enabled: z.boolean(),
      custom:
        customMachineCapabilityDefinitionSchema
          .optional(),
    }),
  ),
});

const persistedSchema = z.union([
  v1Schema,
  v2Schema,
  v3Schema,
]);

export interface MachineCapabilityPreference {
  readonly enabled: boolean;
  readonly custom?:
    CustomMachineCapabilityDefinition;
}

export interface MachineCapabilityPreferences {
  [key: string]:
    MachineCapabilityPreference;
}

function clonePreference(
  preference: MachineCapabilityPreference,
): MachineCapabilityPreference {
  return {
    enabled: preference.enabled,
    ...(preference.custom === undefined
      ? {}
      : {
          custom: {
            ...preference.custom,
            fixedArgs: [
              ...preference.custom.fixedArgs,
            ],
            argumentPolicy:
              preference.custom.argumentPolicy
                .map((rule) => ({
                  mode: rule.mode,
                  args: [...rule.args],
                })),
            environmentPolicy: {
              inherit:
                preference.custom.environmentPolicy
                  .inherit,
              allowNames: [
                ...preference.custom.environmentPolicy
                  .allowNames,
              ],
              denyNames: [
                ...preference.custom.environmentPolicy
                  .denyNames,
              ],
              denyPrefixes: [
                ...preference.custom.environmentPolicy
                  .denyPrefixes,
              ],
              set: {
                ...preference.custom.environmentPolicy
                  .set,
              },
            },
          },
        }),
  };
}

export class MachineCapabilityStateStore {
  #saveQueue:
    Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
  ) {}

  async load():
    Promise<
      MachineCapabilityPreferences | undefined
    > {
    let raw: string;

    try {
      raw = await readFile(
        this.filePath,
        "utf8",
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }

      throw error;
    }

    const parsed =
      persistedSchema.parse(
        JSON.parse(
          raw.replace(
            /^\uFEFF/u,
            "",
          ),
        ) as unknown,
      );

    if (parsed.version === 2) {
      return Object.fromEntries(
        Object.entries(
          parsed.capabilities,
        ).map(([key, value]) => [
          key,
          value.custom === undefined
            ? { enabled: value.enabled }
            : {
                enabled: value.enabled,
                custom: {
                  ...value.custom,
                  environmentPolicy:
                    legacyCustomMachineCapabilityEnvironment(),
                },
              },
        ]),
      );
    }

    return Object.fromEntries(
      Object.entries(
        parsed.capabilities,
      ).map(([key, value]) => [
        key,
        clonePreference(value),
      ]),
    );
  }

  save(
    preferences:
      MachineCapabilityPreferences,
  ): Promise<void> {
    const snapshot = {
      version: 3 as const,
      capabilities:
        Object.fromEntries(
          Object.entries(preferences)
            .map(([key, value]) => [
              key,
              clonePreference(value),
            ]),
        ),
    };

    const operation =
      this.#saveQueue.then(
        async () => {
          const directory = dirname(
            this.filePath,
          );
          await mkdir(
            directory,
            { recursive: true },
          );

          const tempPath =
            `${this.filePath}.${process.pid}.tmp`;
          const payload =
            JSON.stringify(
              snapshot,
              null,
              2,
            );

          await writeFile(
            tempPath,
            `${payload}\n`,
            "utf8",
          );
          await rename(
            tempPath,
            this.filePath,
          );
        },
      );

    this.#saveQueue =
      operation.catch(
        () => undefined,
      );
    return operation;
  }
}
