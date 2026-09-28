import { fileURLToPath } from "node:url";
import {
  runSourceCheck,
  type SourceCheckResult,
} from "./source-check.js";
import {
  spawnManagedWorker,
  type ManagedWorker,
} from "./worker-process.js";
import { reloadWorkerConfiguration } from "./worker-configuration-reload.js";
import { prepareReloadCandidate } from "./worker-reload-candidate.js";
import {
  synchronizeWorkerConfigurations,
  type ConfigurationSyncResult,
} from "./worker-configuration-sync.js";
import {
  WorkerSupervisorLifecycle,
  type WorkerLease,
  type WorkerLifecycleState,
} from "./worker-supervisor-lifecycle.js";

export type {
  ConfigurationSyncResult,
} from "./worker-configuration-sync.js";
export type {
  WorkerLease,
  WorkerStatus,
} from "./worker-supervisor-lifecycle.js";

export interface WorkerSupervisorOptions {
  readonly cwd: string;
  readonly publicMcpOrigin: string;
  readonly publicAdminOrigin: string;
  readonly workerEntryPath?: string;
  readonly initialWorkerEntryPath?: string;
  readonly rollbackWindowMs?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly browserResourceIdleMs?: number;
  readonly jobResultRetentionMs?: number;
  readonly mcpSessionIdleMs?: number;
  readonly maxExitedRecords?: number;
  readonly onWorkerExit?: (
    workerId: string,
  ) => void | Promise<void>;
  readonly canPromote?: () => boolean;
  readonly validate?: () => Promise<SourceCheckResult>;
  readonly spawnWorker?: () => Promise<ManagedWorker>;
  readonly spawnInitialWorker?: () => Promise<ManagedWorker>;
  readonly reloadWorkerConfiguration?: (
    worker: ManagedWorker,
  ) => Promise<void>;
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
  readonly workers:
    WorkerLifecycleState["workers"];
  readonly resourceBindings:
    WorkerLifecycleState["resourceBindings"];
}

export class WorkerSupervisor {
  readonly #lifecycle: WorkerSupervisorLifecycle;
  readonly #canPromote: () => boolean;
  readonly #validate:
    () => Promise<SourceCheckResult>;
  readonly #spawnWorker:
    () => Promise<ManagedWorker>;
  readonly #spawnInitialWorker:
    () => Promise<ManagedWorker>;
  readonly #reloadWorkerConfiguration: (
    worker: ManagedWorker,
  ) => Promise<void>;

  #reloading = false;
  #reloadRequested = false;
  #reloadPromise:
    Promise<ReloadResult> | undefined;
  #lastReloadReason:
    string | undefined;
  #lastFailure: string | undefined;
  #lastCheck:
    SourceCheckResult | undefined;
  #configurationEpoch = 0;
  #closed = false;

  constructor(
    options: WorkerSupervisorOptions,
  ) {
    this.#lifecycle =
      new WorkerSupervisorLifecycle({
        rollbackWindowMs:
          options.rollbackWindowMs,
        browserResourceIdleMs:
          options.browserResourceIdleMs,
        jobResultRetentionMs:
          options.jobResultRetentionMs,
        mcpSessionIdleMs:
          options.mcpSessionIdleMs,
        maxExitedRecords:
          options.maxExitedRecords,
        onFailure: (message) => {
          this.#lastFailure = message;
        },
        onWorkerExit:
          options.onWorkerExit,
      });

    this.#canPromote =
      options.canPromote ?? (() => true);
    this.#validate =
      options.validate ??
      (() =>
        runSourceCheck(
          options.cwd,
          options.environment ??
            process.env,
        ));

    const workerEntryPath =
      options.workerEntryPath ??
      fileURLToPath(
        new URL(
          "./worker-entry.ts",
          import.meta.url,
        ),
      );
    const initialWorkerEntryPath =
      options.initialWorkerEntryPath ??
      workerEntryPath;

    this.#spawnWorker =
      options.spawnWorker ??
      (() =>
        spawnManagedWorker({
          workerEntryPath,
          cwd: options.cwd,
          environment:
            options.environment,
          publicMcpOrigin:
            options.publicMcpOrigin,
          publicAdminOrigin:
            options.publicAdminOrigin,
        }));

    this.#spawnInitialWorker =
      options.spawnInitialWorker ??
      options.spawnWorker ??
      (() =>
        spawnManagedWorker({
          workerEntryPath:
            initialWorkerEntryPath,
          cwd: options.cwd,
          environment:
            options.environment,
          publicMcpOrigin:
            options.publicMcpOrigin,
          publicAdminOrigin:
            options.publicAdminOrigin,
        }));

    this.#reloadWorkerConfiguration =
      options.reloadWorkerConfiguration ??
      reloadWorkerConfiguration;
  }

  async startInitial():
    Promise<ManagedWorker> {
    if (this.#closed) {
      throw new Error(
        "supervisor_closed",
      );
    }

    const active =
      this.#lifecycle.activeWorker();
    if (active !== undefined) {
      return active;
    }

    const worker =
      await this.#spawnInitialWorker();
    this.#lifecycle.registerInitial(
      worker,
    );
    return worker;
  }

  reload(
    reason = "source_changed",
  ): Promise<ReloadResult> {
    if (this.#closed) {
      return Promise.reject(
        new Error("supervisor_closed"),
      );
    }

    this.#lastReloadReason = reason;
    this.#reloadRequested = true;

    if (
      this.#reloadPromise !== undefined
    ) {
      return this.#reloadPromise;
    }

    this.#reloadPromise =
      this.#runReloadLoop().finally(
        () => {
          this.#reloadPromise =
            undefined;
        },
      );

    return this.#reloadPromise;
  }

  async synchronizeConfiguration(
    sourceWorkerId: string,
  ): Promise<ConfigurationSyncResult> {
    if (this.#closed) {
      throw new Error(
        "supervisor_closed",
      );
    }

    this.#configurationEpoch += 1;

    return synchronizeWorkerConfigurations({
      workers:
        this.#lifecycle
          .liveWorkersExcluding(
            sourceWorkerId,
          ),
      reloadWorkerConfiguration:
        this.#reloadWorkerConfiguration,
      onFailure: (message) => {
        this.#lastFailure = message;
      },
      quarantineWorker: (worker) =>
        this.#lifecycle.quarantine(
          worker,
        ),
    });
  }

  acquire(
    sessionId?: string,
    resourceKey?: string,
  ): WorkerLease {
    return this.#lifecycle.acquire(
      sessionId,
      resourceKey,
    );
  }

  bindSession(
    sessionId: string,
    workerId: string,
  ): void {
    this.#lifecycle.bindSession(
      sessionId,
      workerId,
    );
  }

  releaseSession(
    sessionId: string,
  ): void {
    this.#lifecycle.releaseSession(
      sessionId,
    );
  }

  bindResource(
    resourceKey: string,
    workerId: string,
  ): void {
    this.#lifecycle.bindResource(
      resourceKey,
      workerId,
    );
  }

  releaseResource(
    resourceKey: string,
  ): void {
    this.#lifecycle.releaseResource(
      resourceKey,
    );
  }

  markJobTerminal(
    workerId: string,
    jobId: string,
  ): void {
    this.#lifecycle.markJobTerminal(
      workerId,
      jobId,
    );
  }

  markJobHistoryPersisted(
    workerId: string,
    jobId: string,
  ): void {
    this.#lifecycle
      .markJobHistoryPersisted(
        workerId,
        jobId,
      );
  }

  state(): WorkerSupervisorState {
    const lifecycle =
      this.#lifecycle.state();

    return {
      ...(lifecycle.activeWorkerId ===
      undefined
        ? {}
        : {
            activeWorkerId:
              lifecycle.activeWorkerId,
          }),
      reloading: this.#reloading,
      ...(this.#lastReloadReason ===
      undefined
        ? {}
        : {
            lastReloadReason:
              this.#lastReloadReason,
          }),
      ...(this.#lastFailure === undefined
        ? {}
        : {
            lastFailure:
              this.#lastFailure,
          }),
      ...(this.#lastCheck === undefined
        ? {}
        : {
            lastCheck:
              this.#lastCheck,
          }),
      workers: lifecycle.workers,
      resourceBindings:
        lifecycle.resourceBindings,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    await this.#lifecycle.close();
  }

  async #runReloadLoop():
    Promise<ReloadResult> {
    this.#reloading = true;
    let result: ReloadResult = {
      promoted: false,
      reason: "reload_not_started",
    };

    try {
      while (
        this.#reloadRequested &&
        !this.#closed
      ) {
        this.#reloadRequested = false;
        result =
          await this.#reloadOnce();
      }
      return result;
    } finally {
      this.#reloading = false;
    }
  }

  async #reloadOnce():
    Promise<ReloadResult> {
    const prepared =
      await prepareReloadCandidate({
        canPromote:
          this.#canPromote,
        validate: this.#validate,
        spawnWorker:
          this.#spawnWorker,
        reloadWorkerConfiguration:
          this.#reloadWorkerConfiguration,
        configurationEpoch: () =>
          this.#configurationEpoch,
      });

    if (
      prepared.check !== undefined
    ) {
      this.#lastCheck =
        prepared.check;
    }

    if (!prepared.ok) {
      this.#lastFailure =
        prepared.reason;
      return {
        promoted: false,
        reason: prepared.reason,
      };
    }

    const candidate =
      prepared.candidate;
    this.#lifecycle.promote(
      candidate,
    );
    this.#lastFailure = undefined;

    return {
      promoted: true,
      workerId: candidate.id,
    };
  }
}
