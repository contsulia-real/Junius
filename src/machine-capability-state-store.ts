import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const persistedSchema = z.object({
  version: z.literal(1),
  capabilities: z.record(
    z.string().min(1),
    z.object({
      enabled: z.boolean(),
    }),
  ),
});

export interface MachineCapabilityPreferences {
  readonly [key: string]: {
    readonly enabled: boolean;
  };
}

export class MachineCapabilityStateStore {
  #saveQueue: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async load(): Promise<MachineCapabilityPreferences | undefined> {
    let raw: string;

    try {
      raw = await readFile(this.filePath, "utf8");
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

    const parsed = persistedSchema.parse(
      JSON.parse(raw.replace(/^\uFEFF/u, "")) as unknown,
    );

    return Object.fromEntries(
      Object.entries(parsed.capabilities).map(([key, value]) => [
        key,
        { enabled: value.enabled },
      ]),
    );
  }

  save(preferences: MachineCapabilityPreferences): Promise<void> {
    const snapshot = {
      version: 1 as const,
      capabilities: preferences,
    };

    const operation = this.#saveQueue.then(async () => {
      const directory = dirname(this.filePath);
      await mkdir(directory, { recursive: true });

      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      const payload = JSON.stringify(snapshot, null, 2);

      await writeFile(tempPath, `${payload}\n`, "utf8");
      await rename(tempPath, this.filePath);
    });

    this.#saveQueue = operation.catch(() => undefined);
    return operation;
  }
}
