import type { ManagedWorker } from "./worker-process.js";

export interface ConfigurationSyncResult {
  readonly synchronizedWorkerIds: readonly string[];
  readonly quarantinedWorkerIds: readonly string[];
}

export interface WorkerConfigurationSyncOptions {
  readonly workers: readonly ManagedWorker[];
  readonly reloadWorkerConfiguration: (
    worker: ManagedWorker,
  ) => Promise<void>;
  readonly quarantineWorker: (
    worker: ManagedWorker,
  ) => Promise<void>;
  readonly onFailure?: (message: string) => void;
}

export async function synchronizeWorkerConfigurations(
  options: WorkerConfigurationSyncOptions,
): Promise<ConfigurationSyncResult> {
  const synchronizedWorkerIds: string[] = [];
  const quarantinedWorkerIds: string[] = [];

  await Promise.all(
    options.workers.map(async (worker) => {
      try {
        await options.reloadWorkerConfiguration(worker);
        synchronizedWorkerIds.push(worker.id);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);
        options.onFailure?.(
          `configuration_sync_failed: ${worker.id}: ${message}`,
        );

        await options.quarantineWorker(worker);
        quarantinedWorkerIds.push(worker.id);
      }
    }),
  );

  return {
    synchronizedWorkerIds:
      synchronizedWorkerIds.sort(),
    quarantinedWorkerIds:
      quarantinedWorkerIds.sort(),
  };
}
