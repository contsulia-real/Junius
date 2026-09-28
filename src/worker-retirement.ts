import type { ManagedWorker } from "./worker-process.js";

export type WorkerStatus =
  | "active"
  | "retiring"
  | "exited";

export interface WorkerRecord {
  readonly worker: ManagedWorker;
  promotedAt: string;
  retiredAt?: string;
  status: WorkerStatus;
  inFlight: number;
  retireTimer?: NodeJS.Timeout;
}

export interface WorkerRetirementManagerOptions {
  readonly rollbackWindowMs?: number;
  readonly activeWorkerId: () =>
    string | undefined;
  readonly hasAffinity: (
    workerId: string,
  ) => boolean;
  readonly onReaped: () => void;
}

export class WorkerRetirementManager {
  readonly #rollbackWindowMs: number;
  readonly #activeWorkerId: () =>
    string | undefined;
  readonly #hasAffinity: (
    workerId: string,
  ) => boolean;
  readonly #onReaped: () => void;

  constructor(
    options: WorkerRetirementManagerOptions,
  ) {
    this.#rollbackWindowMs =
      options.rollbackWindowMs ?? 60_000;
    this.#activeWorkerId =
      options.activeWorkerId;
    this.#hasAffinity =
      options.hasAffinity;
    this.#onReaped = options.onReaped;
  }

  clear(record: WorkerRecord): void {
    if (record.retireTimer !== undefined) {
      clearTimeout(record.retireTimer);
      record.retireTimer = undefined;
    }
  }

  clearAll(
    records: Iterable<WorkerRecord>,
  ): void {
    for (const record of records) {
      this.clear(record);
    }
  }

  schedule(record: WorkerRecord): void {
    this.clear(record);

    record.retireTimer = setTimeout(() => {
      record.retireTimer = undefined;
      this.maybeReap(record);
    }, this.#rollbackWindowMs);
  }

  maybeReap(record: WorkerRecord): void {
    if (
      record.status !== "retiring" ||
      record.worker.id ===
        this.#activeWorkerId()
    ) {
      return;
    }

    if (record.retiredAt !== undefined) {
      const reapAfter =
        Date.parse(record.retiredAt) +
        this.#rollbackWindowMs;
      const remaining =
        reapAfter - Date.now();

      if (remaining > 0) {
        this.clear(record);
        record.retireTimer =
          setTimeout(() => {
            record.retireTimer =
              undefined;
            this.maybeReap(record);
          }, remaining);
        return;
      }
    }

    if (
      record.inFlight > 0 ||
      this.#hasAffinity(
        record.worker.id,
      )
    ) {
      if (
        record.retireTimer === undefined
      ) {
        record.retireTimer =
          setTimeout(() => {
            record.retireTimer =
              undefined;
            this.maybeReap(record);
          }, 5_000);
      }
      return;
    }

    void record.worker.close().finally(() => {
      record.status = "exited";
      this.#onReaped();
    });
  }
}
