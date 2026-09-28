import {
  WorkerAffinityRegistry,
  type ResourceBindingState,
} from "./worker-affinity-registry.js";
import type { ManagedWorker } from "./worker-process.js";

export type WorkerStatus =
  | "active"
  | "retiring"
  | "exited";

interface WorkerRecord {
  readonly worker: ManagedWorker;
  promotedAt: string;
  retiredAt?: string;
  status: WorkerStatus;
  inFlight: number;
  retireTimer?: NodeJS.Timeout;
}

export interface WorkerLease {
  readonly worker: ManagedWorker;
  release(): void;
}

export interface WorkerLifecycleState {
  readonly activeWorkerId?: string;
  readonly workers: readonly {
    readonly id: string;
    readonly pid: number;
    readonly status: WorkerStatus;
    readonly startedAt: string;
    readonly promotedAt: string;
    readonly retiredAt?: string;
    readonly sessions: number;
    readonly resources: number;
    readonly inFlight: number;
  }[];
  readonly resourceBindings:
    readonly ResourceBindingState[];
}

export interface WorkerSupervisorLifecycleOptions {
  readonly rollbackWindowMs?: number;
  readonly browserResourceIdleMs?: number;
  readonly desktopResourceIdleMs?: number;
  readonly jobResultRetentionMs?: number;
  readonly mcpSessionIdleMs?: number;
  readonly maxExitedRecords?: number;
  readonly onFailure: (message: string) => void;
}

const DEFAULT_MAX_EXITED_RECORDS = 16;

export class WorkerSupervisorLifecycle {
  readonly #records =
    new Map<string, WorkerRecord>();
  readonly #affinity: WorkerAffinityRegistry;
  readonly #rollbackWindowMs: number;
  readonly #maxExitedRecords: number;
  readonly #onFailure: (message: string) => void;

  #activeWorkerId: string | undefined;

  constructor(
    options: WorkerSupervisorLifecycleOptions,
  ) {
    this.#rollbackWindowMs =
      options.rollbackWindowMs ?? 60_000;
    this.#maxExitedRecords = Math.max(
      0,
      Math.floor(
        options.maxExitedRecords ??
          DEFAULT_MAX_EXITED_RECORDS,
      ),
    );
    this.#onFailure = options.onFailure;

    this.#affinity = new WorkerAffinityRegistry({
      browserResourceIdleMs:
        options.browserResourceIdleMs,
      desktopResourceIdleMs:
        options.desktopResourceIdleMs,
      jobResultRetentionMs:
        options.jobResultRetentionMs,
      mcpSessionIdleMs:
        options.mcpSessionIdleMs,
      isWorkerAvailable: (workerId) => {
        const record = this.#records.get(workerId);
        return (
          record !== undefined &&
          record.status !== "exited"
        );
      },
      onAffinityReleased: (workerId) => {
        const record = this.#records.get(workerId);
        if (record !== undefined) {
          this.#maybeReap(record);
        }
      },
    });
  }

  get activeWorkerId(): string | undefined {
    return this.#activeWorkerId;
  }

  activeWorker(): ManagedWorker | undefined {
    return this.#activeWorkerId === undefined
      ? undefined
      : this.#record(this.#activeWorkerId).worker;
  }

  registerInitial(worker: ManagedWorker): void {
    this.#register(worker, "active");
    this.#activeWorkerId = worker.id;
  }

  promote(worker: ManagedWorker): void {
    const previousId = this.#activeWorkerId;
    this.#register(worker, "active");
    this.#activeWorkerId = worker.id;

    if (
      previousId === undefined ||
      previousId === worker.id
    ) {
      return;
    }

    const previous =
      this.#records.get(previousId);
    if (
      previous === undefined ||
      previous.status === "exited"
    ) {
      return;
    }

    previous.status = "retiring";
    previous.retiredAt =
      new Date().toISOString();
    this.#affinity.retireWorker(
      previous.worker.id,
    );
    this.#scheduleReap(previous);
  }

  liveWorkersExcluding(
    workerId: string,
  ): readonly ManagedWorker[] {
    return [...this.#records.values()]
      .filter(
        (record) =>
          record.worker.id !== workerId &&
          record.status !== "exited" &&
          !record.worker.exited(),
      )
      .map((record) => record.worker);
  }

  async quarantine(
    worker: ManagedWorker,
  ): Promise<void> {
    await worker.close().catch(() => undefined);

    const record =
      this.#records.get(worker.id);
    if (
      record !== undefined &&
      record.status !== "exited"
    ) {
      this.#onWorkerExit(worker.id);
    }
  }

  acquire(
    sessionId?: string,
    resourceKey?: string,
  ): WorkerLease {
    const workerId =
      this.#affinity.resolve(
        sessionId,
        resourceKey,
      ) ?? this.#activeWorkerId;

    if (workerId === undefined) {
      throw new Error("no_active_worker");
    }

    const record = this.#record(workerId);
    record.inFlight += 1;

    let released = false;
    return {
      worker: record.worker,
      release: () => {
        if (released) return;
        released = true;
        record.inFlight = Math.max(
          0,
          record.inFlight - 1,
        );
        this.#maybeReap(record);
      },
    };
  }

  bindSession(
    sessionId: string,
    workerId: string,
  ): void {
    this.#affinity.bindSession(
      sessionId,
      workerId,
    );
  }

  releaseSession(sessionId: string): void {
    this.#affinity.releaseSession(sessionId);
  }

  bindResource(
    resourceKey: string,
    workerId: string,
  ): void {
    this.#affinity.bindResource(
      resourceKey,
      workerId,
    );
  }

  releaseResource(resourceKey: string): void {
    this.#affinity.releaseResource(resourceKey);
  }

  markJobTerminal(
    workerId: string,
    jobId: string,
  ): void {
    this.#affinity.markJobTerminal(
      workerId,
      jobId,
    );
  }

  markJobHistoryPersisted(
    workerId: string,
    jobId: string,
  ): void {
    this.#affinity.markJobHistoryPersisted(
      workerId,
      jobId,
    );
  }

  state(): WorkerLifecycleState {
    return {
      ...(this.#activeWorkerId === undefined
        ? {}
        : {
            activeWorkerId:
              this.#activeWorkerId,
          }),
      workers: [...this.#records.values()]
        .map((record) => ({
          id: record.worker.id,
          pid: record.worker.pid,
          status: record.status,
          startedAt: record.worker.startedAt,
          promotedAt: record.promotedAt,
          ...(record.retiredAt === undefined
            ? {}
            : {
                retiredAt:
                  record.retiredAt,
              }),
          sessions:
            this.#affinity.sessionCount(
              record.worker.id,
            ),
          resources:
            this.#affinity.resourceCount(
              record.worker.id,
            ),
          inFlight: record.inFlight,
        }))
        .sort((left, right) =>
          left.startedAt.localeCompare(
            right.startedAt,
          ),
        ),
      resourceBindings:
        this.#affinity.resourceBindings(),
    };
  }

  async close(): Promise<void> {
    for (const record of this.#records.values()) {
      if (record.retireTimer !== undefined) {
        clearTimeout(record.retireTimer);
      }
    }

    await Promise.allSettled(
      [...this.#records.values()].map(
        (record) => record.worker.close(),
      ),
    );

    this.#affinity.close();
    this.#records.clear();
    this.#activeWorkerId = undefined;
  }

  #register(
    worker: ManagedWorker,
    status: WorkerStatus,
  ): void {
    const record: WorkerRecord = {
      worker,
      promotedAt: new Date().toISOString(),
      status,
      inFlight: 0,
    };

    this.#records.set(worker.id, record);

    worker.child.on(
      "message",
      (message: unknown) => {
        this.#onWorkerMessage(
          worker.id,
          message,
        );
      },
    );

    worker.child.once("exit", () => {
      this.#onWorkerExit(worker.id);
    });
  }

  #onWorkerExit(workerId: string): void {
    const record =
      this.#records.get(workerId);
    if (record === undefined) return;

    record.status = "exited";
    if (record.retireTimer !== undefined) {
      clearTimeout(record.retireTimer);
      record.retireTimer = undefined;
    }

    this.#affinity.removeWorker(workerId);

    if (this.#activeWorkerId !== workerId) {
      this.#pruneExitedRecords();
      return;
    }

    const fallback =
      [...this.#records.values()]
        .filter(
          (candidate) =>
            candidate.worker.id !==
              workerId &&
            candidate.status !== "exited" &&
            !candidate.worker.exited(),
        )
        .sort((left, right) =>
          right.promotedAt.localeCompare(
            left.promotedAt,
          ),
        )[0];

    if (fallback === undefined) {
      this.#activeWorkerId = undefined;
      this.#onFailure(
        "active_worker_exited_without_fallback",
      );
      this.#pruneExitedRecords();
      return;
    }

    if (fallback.retireTimer !== undefined) {
      clearTimeout(fallback.retireTimer);
      fallback.retireTimer = undefined;
    }
    fallback.status = "active";
    fallback.retiredAt = undefined;
    fallback.promotedAt =
      new Date().toISOString();
    this.#affinity.activateWorker(
      fallback.worker.id,
    );
    this.#activeWorkerId =
      fallback.worker.id;
    this.#onFailure(
      `active_worker_exited_rolled_back_to: ${fallback.worker.id}`,
    );
    this.#pruneExitedRecords();
  }

  #onWorkerMessage(
    workerId: string,
    message: unknown,
  ): void {
    if (
      typeof message !== "object" ||
      message === null
    ) {
      return;
    }

    const candidate = message as {
      readonly type?: string;
      readonly workerId?: string;
      readonly jobId?: string;
    };

    if (
      candidate.workerId !== workerId ||
      typeof candidate.jobId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        candidate.jobId,
      )
    ) {
      return;
    }

    if (
      candidate.type ===
      "junius-job-terminal"
    ) {
      this.markJobTerminal(
        workerId,
        candidate.jobId,
      );
      return;
    }

    if (
      candidate.type ===
      "junius-job-history-persisted"
    ) {
      this.markJobHistoryPersisted(
        workerId,
        candidate.jobId,
      );
    }
  }

  #pruneExitedRecords(): void {
    const exited =
      [...this.#records.values()]
        .filter(
          (record) =>
            record.status === "exited" &&
            record.worker.id !==
              this.#activeWorkerId,
        )
        .sort((left, right) =>
          right.promotedAt.localeCompare(
            left.promotedAt,
          ),
        );

    for (const record of exited.slice(
      this.#maxExitedRecords,
    )) {
      this.#records.delete(
        record.worker.id,
      );
    }
  }

  #scheduleReap(
    record: WorkerRecord,
  ): void {
    if (record.retireTimer !== undefined) {
      clearTimeout(record.retireTimer);
    }

    record.retireTimer = setTimeout(() => {
      record.retireTimer = undefined;
      this.#maybeReap(record);
    }, this.#rollbackWindowMs);
  }

  #maybeReap(record: WorkerRecord): void {
    if (
      record.status !== "retiring" ||
      record.worker.id ===
        this.#activeWorkerId
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
        if (
          record.retireTimer !== undefined
        ) {
          clearTimeout(
            record.retireTimer,
          );
        }
        record.retireTimer =
          setTimeout(() => {
            record.retireTimer =
              undefined;
            this.#maybeReap(record);
          }, remaining);
        return;
      }
    }

    if (
      record.inFlight > 0 ||
      this.#affinity.hasAffinity(
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
            this.#maybeReap(record);
          }, 5_000);
      }
      return;
    }

    void record.worker.close().finally(() => {
      record.status = "exited";
      this.#pruneExitedRecords();
    });
  }

  #record(workerId: string): WorkerRecord {
    const record =
      this.#records.get(workerId);
    if (record === undefined) {
      throw new Error(
        `worker_not_found: ${workerId}`,
      );
    }
    return record;
  }
}
