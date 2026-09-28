import { WorkerAffinityRegistry } from "./worker-affinity-registry.js";
import type { ManagedWorker } from "./worker-process.js";
import { parseWorkerJobIpcEvent } from "./worker-job-ipc.js";
import {
  WorkerRetirementManager,
  type WorkerRecord,
  type WorkerStatus,
} from "./worker-retirement.js";

export type { WorkerStatus } from "./worker-retirement.js";
import {
  buildWorkerLifecycleState,
  requiredWorkerRecord,
  type WorkerLifecycleState,
} from "./worker-lifecycle-state.js";

export type { WorkerLifecycleState } from "./worker-lifecycle-state.js";

export interface WorkerLease {
  readonly worker: ManagedWorker;
  release(): void;
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
  readonly #maxExitedRecords: number;
  readonly #retirement: WorkerRetirementManager;
  readonly #onFailure: (message: string) => void;

  #activeWorkerId: string | undefined;

  constructor(
    options: WorkerSupervisorLifecycleOptions,
  ) {
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
          this.#retirement.maybeReap(record);
        }
      },
    });

    this.#retirement =
      new WorkerRetirementManager({
        rollbackWindowMs:
          options.rollbackWindowMs,
        activeWorkerId: () =>
          this.#activeWorkerId,
        hasAffinity: (workerId) =>
          this.#affinity.hasAffinity(
            workerId,
          ),
        onReaped: () => {
          this.#pruneExitedRecords();
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
    this.#retirement.schedule(previous);
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
        this.#retirement.maybeReap(record);
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
    return buildWorkerLifecycleState(
      this.#records,
      this.#activeWorkerId,
      this.#affinity,
    );
  }

  async close(): Promise<void> {
    this.#retirement.clearAll(
      this.#records.values(),
    );

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
    this.#retirement.clear(record);

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

    this.#retirement.clear(fallback);
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
    const event =
      parseWorkerJobIpcEvent(
        workerId,
        message,
      );
    if (event === undefined) {
      return;
    }

    if (event.type === "terminal") {
      this.markJobTerminal(
        workerId,
        event.jobId,
      );
      return;
    }

    this.markJobHistoryPersisted(
      workerId,
      event.jobId,
    );
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

  #record(workerId: string): WorkerRecord {
    return requiredWorkerRecord(
      this.#records,
      workerId,
    );
  }
}
