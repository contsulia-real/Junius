import { fileURLToPath } from "node:url";
import { runSourceCheck, type SourceCheckResult } from "./source-check.js";
import {
  spawnManagedWorker,
  type ManagedWorker,
} from "./worker-process.js";
import { WorkerAffinityRegistry } from "./worker-affinity-registry.js";
import { reloadWorkerConfiguration } from "./worker-configuration-reload.js";
import { prepareReloadCandidate } from "./worker-reload-candidate.js";
import {
  synchronizeWorkerConfigurations,
  type ConfigurationSyncResult,
} from "./worker-configuration-sync.js";

export type { ConfigurationSyncResult } from "./worker-configuration-sync.js";

type WorkerStatus = "active" | "retiring" | "exited";

interface WorkerRecord {
  readonly worker: ManagedWorker;
  promotedAt: string;
  retiredAt?: string;
  status: WorkerStatus;
  inFlight: number;
  retireTimer?: NodeJS.Timeout;
}

const DEFAULT_MAX_EXITED_RECORDS = 16;

export interface WorkerSupervisorOptions {
  readonly cwd: string;
  readonly publicMcpOrigin: string;
  readonly publicAdminOrigin: string;
  readonly workerEntryPath?: string;
  readonly initialWorkerEntryPath?: string;
  readonly rollbackWindowMs?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly browserResourceIdleMs?: number;
  readonly desktopResourceIdleMs?: number;
  readonly jobResultRetentionMs?: number;
  readonly mcpSessionIdleMs?: number;
  readonly maxExitedRecords?: number;
  readonly canPromote?: () => boolean;
  readonly validate?: () => Promise<SourceCheckResult>;
  readonly spawnWorker?: () => Promise<ManagedWorker>;
  readonly spawnInitialWorker?: () => Promise<ManagedWorker>;
  readonly reloadWorkerConfiguration?: (
    worker: ManagedWorker,
  ) => Promise<void>;
}

export interface WorkerLease {
  readonly worker: ManagedWorker;
  release(): void;
}

export interface ReloadResult {
  readonly promoted: boolean;
  readonly workerId?: string;
  readonly reason?: string;
}

export interface WorkerSupervisorState {
  readonly activeWorkerId?: string;
  readonly reloading: boolean;
  readonly lastReloadReason?: string;
  readonly lastFailure?: string;
  readonly lastCheck?: SourceCheckResult;
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
  readonly resourceBindings: readonly {
    readonly key: string;
    readonly workerId: string;
    readonly boundAt: string;
    readonly lastUsedAt: string;
    readonly expiresAt?: string;
  }[];
}

export class WorkerSupervisor {
  readonly #records = new Map<string, WorkerRecord>();
  readonly #affinity: WorkerAffinityRegistry;
  readonly #rollbackWindowMs: number;
  readonly #maxExitedRecords: number;
  readonly #canPromote: () => boolean;
  readonly #validate: () => Promise<SourceCheckResult>;
  readonly #spawnWorker: () => Promise<ManagedWorker>;
  readonly #spawnInitialWorker: () => Promise<ManagedWorker>;
  readonly #reloadWorkerConfiguration: (
    worker: ManagedWorker,
  ) => Promise<void>;

  #activeWorkerId: string | undefined;
  #reloading = false;
  #reloadRequested = false;
  #reloadPromise: Promise<ReloadResult> | undefined;
  #lastReloadReason: string | undefined;
  #lastFailure: string | undefined;
  #lastCheck: SourceCheckResult | undefined;
  #configurationEpoch = 0;
  #closed = false;

  constructor(options: WorkerSupervisorOptions) {
    this.#rollbackWindowMs =
      options.rollbackWindowMs ?? 60_000;
    this.#affinity = new WorkerAffinityRegistry({
      browserResourceIdleMs: options.browserResourceIdleMs,
      desktopResourceIdleMs: options.desktopResourceIdleMs,
      jobResultRetentionMs: options.jobResultRetentionMs,
      mcpSessionIdleMs: options.mcpSessionIdleMs,
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
    this.#maxExitedRecords = Math.max(
      0,
      Math.floor(
        options.maxExitedRecords ??
          DEFAULT_MAX_EXITED_RECORDS,
      ),
    );
    this.#canPromote =
      options.canPromote ?? (() => true);
    this.#validate =
      options.validate ??
      (() =>
        runSourceCheck(
          options.cwd,
          options.environment ?? process.env,
        ));

    const workerEntryPath =
      options.workerEntryPath ??
      fileURLToPath(new URL("./worker-entry.ts", import.meta.url));
    const initialWorkerEntryPath =
      options.initialWorkerEntryPath ??
      workerEntryPath;

    this.#spawnWorker =
      options.spawnWorker ??
      (() =>
        spawnManagedWorker({
          workerEntryPath,
          cwd: options.cwd,
          environment: options.environment,
          publicMcpOrigin: options.publicMcpOrigin,
          publicAdminOrigin: options.publicAdminOrigin,
        }));

    this.#spawnInitialWorker =
      options.spawnInitialWorker ??
      options.spawnWorker ??
      (() =>
        spawnManagedWorker({
          workerEntryPath: initialWorkerEntryPath,
          cwd: options.cwd,
          environment: options.environment,
          publicMcpOrigin: options.publicMcpOrigin,
          publicAdminOrigin: options.publicAdminOrigin,
        }));
    this.#reloadWorkerConfiguration =
      options.reloadWorkerConfiguration ??
      reloadWorkerConfiguration;
  }

  async startInitial(): Promise<ManagedWorker> {
    if (this.#closed) {
      throw new Error("supervisor_closed");
    }

    if (this.#activeWorkerId !== undefined) {
      return this.#record(this.#activeWorkerId).worker;
    }

    const worker = await this.#spawnInitialWorker();
    this.#register(worker, "active");
    this.#activeWorkerId = worker.id;
    return worker;
  }

  reload(reason = "source_changed"): Promise<ReloadResult> {
    if (this.#closed) {
      return Promise.reject(new Error("supervisor_closed"));
    }

    this.#lastReloadReason = reason;
    this.#reloadRequested = true;

    if (this.#reloadPromise !== undefined) {
      return this.#reloadPromise;
    }

    this.#reloadPromise = this.#runReloadLoop().finally(() => {
      this.#reloadPromise = undefined;
    });

    return this.#reloadPromise;
  }

  async synchronizeConfiguration(
    sourceWorkerId: string,
  ): Promise<ConfigurationSyncResult> {
    if (this.#closed) {
      throw new Error("supervisor_closed");
    }

    this.#configurationEpoch += 1;
    const workers = [...this.#records.values()]
      .filter(
        (record) =>
          record.worker.id !== sourceWorkerId &&
          record.status !== "exited" &&
          !record.worker.exited(),
      )
      .map((record) => record.worker);

    return synchronizeWorkerConfigurations({
      workers,
      reloadWorkerConfiguration:
        this.#reloadWorkerConfiguration,
      onFailure: (message) => {
        this.#lastFailure = message;
      },
      quarantineWorker: async (worker) => {
        await worker.close().catch(() => undefined);
        const record = this.#records.get(worker.id);
        if (
          record !== undefined &&
          record.status !== "exited"
        ) {
          this.#onWorkerExit(worker.id);
        }
      },
    });
  }

  acquire(
    sessionId?: string,
    resourceKey?: string,
  ): WorkerLease {
    const workerId =
      this.#affinity.resolve(sessionId, resourceKey) ??
      this.#activeWorkerId;

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
        record.inFlight = Math.max(0, record.inFlight - 1);
        this.#maybeReap(record);
      },
    };
  }

  bindSession(sessionId: string, workerId: string): void {
    this.#affinity.bindSession(sessionId, workerId);
  }

  releaseSession(sessionId: string): void {
    this.#affinity.releaseSession(sessionId);
  }

  bindResource(resourceKey: string, workerId: string): void {
    this.#affinity.bindResource(resourceKey, workerId);
  }

  releaseResource(resourceKey: string): void {
    this.#affinity.releaseResource(resourceKey);
  }

  markJobTerminal(workerId: string, jobId: string): void {
    this.#affinity.markJobTerminal(workerId, jobId);
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

  state(): WorkerSupervisorState {
    return {
      ...(this.#activeWorkerId === undefined
        ? {}
        : { activeWorkerId: this.#activeWorkerId }),
      reloading: this.#reloading,
      ...(this.#lastReloadReason === undefined
        ? {}
        : { lastReloadReason: this.#lastReloadReason }),
      ...(this.#lastFailure === undefined
        ? {}
        : { lastFailure: this.#lastFailure }),
      ...(this.#lastCheck === undefined
        ? {}
        : { lastCheck: this.#lastCheck }),
      workers: [...this.#records.values()]
        .map((record) => ({
          id: record.worker.id,
          pid: record.worker.pid,
          status: record.status,
          startedAt: record.worker.startedAt,
          promotedAt: record.promotedAt,
          ...(record.retiredAt === undefined
            ? {}
            : { retiredAt: record.retiredAt }),
          sessions: this.#affinity.sessionCount(
            record.worker.id,
          ),
          resources: this.#affinity.resourceCount(
            record.worker.id,
          ),
          inFlight: record.inFlight,
        }))
        .sort((left, right) =>
          left.startedAt.localeCompare(right.startedAt),
        ),
      resourceBindings: this.#affinity.resourceBindings(),
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    for (const record of this.#records.values()) {
      if (record.retireTimer !== undefined) {
        clearTimeout(record.retireTimer);
      }
    }

    await Promise.allSettled(
      [...this.#records.values()].map((record) =>
        record.worker.close(),
      ),
    );

    this.#affinity.close();
    this.#records.clear();
    this.#activeWorkerId = undefined;
  }

  async #runReloadLoop(): Promise<ReloadResult> {
    this.#reloading = true;
    let result: ReloadResult = {
      promoted: false,
      reason: "reload_not_started",
    };

    try {
      while (this.#reloadRequested && !this.#closed) {
        this.#reloadRequested = false;
        result = await this.#reloadOnce();
      }
      return result;
    } finally {
      this.#reloading = false;
    }
  }

  async #reloadOnce(): Promise<ReloadResult> {
    const prepared = await prepareReloadCandidate({
      canPromote: this.#canPromote,
      validate: this.#validate,
      spawnWorker: this.#spawnWorker,
      reloadWorkerConfiguration:
        this.#reloadWorkerConfiguration,
      configurationEpoch: () => this.#configurationEpoch,
    });

    if (prepared.check !== undefined) {
      this.#lastCheck = prepared.check;
    }

    if (!prepared.ok) {
      this.#lastFailure = prepared.reason;
      return {
        promoted: false,
        reason: prepared.reason,
      };
    }

    const candidate = prepared.candidate;
    const previousId = this.#activeWorkerId;
    this.#register(candidate, "active");
    this.#activeWorkerId = candidate.id;
    this.#lastFailure = undefined;

    if (
      previousId !== undefined &&
      previousId !== candidate.id
    ) {
      const previous = this.#records.get(previousId);
      if (
        previous !== undefined &&
        previous.status !== "exited"
      ) {
        previous.status = "retiring";
        previous.retiredAt = new Date().toISOString();
        this.#affinity.retireWorker(
          previous.worker.id,
        );
        this.#scheduleReap(previous);
      }
    }

    return {
      promoted: true,
      workerId: candidate.id,
    };
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

    worker.child.on("message", (message: unknown) => {
      this.#onWorkerMessage(worker.id, message);
    });

    worker.child.once("exit", () => {
      this.#onWorkerExit(worker.id);
    });
  }

  #onWorkerExit(workerId: string): void {
    const record = this.#records.get(workerId);
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

    const fallback = [...this.#records.values()]
      .filter(
        (candidate) =>
          candidate.worker.id !== workerId &&
          candidate.status !== "exited" &&
          !candidate.worker.exited(),
      )
      .sort((left, right) =>
        right.promotedAt.localeCompare(left.promotedAt),
      )[0];

    if (fallback === undefined) {
      this.#activeWorkerId = undefined;
      this.#lastFailure = "active_worker_exited_without_fallback";
      this.#pruneExitedRecords();
      return;
    }

    if (fallback.retireTimer !== undefined) {
      clearTimeout(fallback.retireTimer);
      fallback.retireTimer = undefined;
    }
    fallback.status = "active";
    fallback.retiredAt = undefined;
    fallback.promotedAt = new Date().toISOString();
    this.#affinity.activateWorker(
      fallback.worker.id,
    );
    this.#activeWorkerId = fallback.worker.id;
    this.#lastFailure =
      `active_worker_exited_rolled_back_to: ${fallback.worker.id}`;
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

    if (candidate.type === "junius-job-terminal") {
      this.markJobTerminal(workerId, candidate.jobId);
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
    const exited = [...this.#records.values()]
      .filter(
        (record) =>
          record.status === "exited" &&
          record.worker.id !== this.#activeWorkerId,
      )
      .sort((left, right) =>
        right.promotedAt.localeCompare(left.promotedAt),
      );

    for (const record of exited.slice(
      this.#maxExitedRecords,
    )) {
      this.#records.delete(record.worker.id);
    }
  }

  #scheduleReap(record: WorkerRecord): void {
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
      record.worker.id === this.#activeWorkerId
    ) {
      return;
    }

    if (record.retiredAt !== undefined) {
      const reapAfter =
        Date.parse(record.retiredAt) +
        this.#rollbackWindowMs;
      const remaining = reapAfter - Date.now();

      if (remaining > 0) {
        if (record.retireTimer !== undefined) {
          clearTimeout(record.retireTimer);
        }
        record.retireTimer = setTimeout(() => {
          record.retireTimer = undefined;
          this.#maybeReap(record);
        }, remaining);
        return;
      }
    }

    if (
      record.inFlight > 0 ||
      this.#affinity.hasAffinity(record.worker.id)
    ) {
      if (record.retireTimer === undefined) {
        record.retireTimer = setTimeout(() => {
          record.retireTimer = undefined;
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
    const record = this.#records.get(workerId);
    if (record === undefined) {
      throw new Error(`worker_not_found: ${workerId}`);
    }
    return record;
  }
}
