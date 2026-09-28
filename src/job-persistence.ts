import type {
  JobHistoryStore,
  PersistedJobMetadata,
  PersistedJobRecord,
  RunningJobMarker,
} from "./job-history-store.js";
import {
  persistedRecord,
  snapshot,
  type JobRecord,
} from "./job-manager-runtime.js";
import {
  JobManagerError,
  type JobSnapshot,
} from "./job-manager-types.js";

export interface JobPersistenceOptions {
  readonly onPersisted?: (job: JobSnapshot) => void;
  readonly afterPersisted?: (record: JobRecord) => void;
}

export class JobPersistenceCoordinator {
  readonly #pending = new Set<Promise<void>>();

  constructor(
    private readonly history?: JobHistoryStore,
    private readonly options: JobPersistenceOptions = {},
  ) {}

  stats() {
    return this.history?.stats();
  }

  async markRunning(
    marker: RunningJobMarker,
  ): Promise<void> {
    await this.history?.saveRunning(marker);
  }

  async clearRunning(
    id: string,
  ): Promise<void> {
    await this.history?.clearRunning(id);
  }

  async listMetadata(
    limit?: number,
  ): Promise<readonly PersistedJobMetadata[]> {
    return this.history === undefined
      ? []
      : this.history.listMetadata(limit);
  }

  persist(record: JobRecord): void {
    if (this.history === undefined) {
      return;
    }

    const persisted = persistedRecord(record);
    if (persisted === undefined) {
      return;
    }

    const task = this.history
      .save(persisted)
      .then(async () => {
        await this.history
          ?.clearRunning(record.id)
          .catch((error: unknown) => {
            console.error(
              `[job-running-marker ${record.id}]`,
              error,
            );
          });

        const persistedSnapshotValue =
          snapshot(record);

        try {
          this.options.onPersisted?.(
            persistedSnapshotValue,
          );
        } catch {
          // Persistence success must not be changed by observer failures.
        }

        this.options.afterPersisted?.(record);
      })
      .catch((error: unknown) => {
        console.error(
          `[job-history ${record.id}]`,
          error,
        );
      });

    this.#pending.add(task);
    void task.finally(() => {
      this.#pending.delete(task);
    });
  }

  async loadMetadata(
    id: string,
  ): Promise<PersistedJobMetadata> {
    const record =
      await this.history?.loadMetadata(id);
    if (record !== undefined) {
      return record;
    }

    throw new JobManagerError(
      "job_not_found",
      `Job is not registered in this Junius process or terminal history: ${id}`,
    );
  }

  async loadRecord(
    id: string,
  ): Promise<PersistedJobRecord> {
    const record = await this.history?.load(id);
    if (record !== undefined) {
      return record;
    }

    throw new JobManagerError(
      "job_not_found",
      `Job is not registered in this Junius process or terminal history: ${id}`,
    );
  }

  async waitPending(): Promise<void> {
    await Promise.allSettled([
      ...this.#pending,
    ]);
  }
}
