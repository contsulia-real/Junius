import { fileURLToPath } from "node:url";
import { runSourceCheck, type SourceCheckResult } from "./source-check.js";
import {
  spawnManagedWorker,
  type ManagedWorker,
} from "./worker-process.js";

type WorkerStatus = "active" | "retiring" | "exited";

interface WorkerRecord {
  readonly worker: ManagedWorker;
  readonly sessions: Set<string>;
  promotedAt: string;
  retiredAt?: string;
  status: WorkerStatus;
  inFlight: number;
  retireTimer?: NodeJS.Timeout;
}

export interface WorkerSupervisorOptions {
  readonly cwd: string;
  readonly publicMcpOrigin: string;
  readonly publicAdminOrigin: string;
  readonly workerEntryPath?: string;
  readonly rollbackWindowMs?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly validate?: () => Promise<SourceCheckResult>;
  readonly spawnWorker?: () => Promise<ManagedWorker>;
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
    readonly inFlight: number;
  }[];
}

export class WorkerSupervisor {
  readonly #records = new Map<string, WorkerRecord>();
  readonly #sessionRoutes = new Map<string, string>();
  readonly #rollbackWindowMs: number;
  readonly #validate: () => Promise<SourceCheckResult>;
  readonly #spawnWorker: () => Promise<ManagedWorker>;

  #activeWorkerId: string | undefined;
  #reloading = false;
  #reloadRequested = false;
  #reloadPromise: Promise<ReloadResult> | undefined;
  #lastReloadReason: string | undefined;
  #lastFailure: string | undefined;
  #lastCheck: SourceCheckResult | undefined;
  #closed = false;

  constructor(options: WorkerSupervisorOptions) {
    this.#rollbackWindowMs =
      options.rollbackWindowMs ?? 60_000;
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
  }

  async startInitial(): Promise<ManagedWorker> {
    if (this.#closed) {
      throw new Error("supervisor_closed");
    }

    if (this.#activeWorkerId !== undefined) {
      return this.#record(this.#activeWorkerId).worker;
    }

    const worker = await this.#spawnWorker();
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

  acquire(sessionId?: string): WorkerLease {
    let workerId =
      sessionId === undefined
        ? undefined
        : this.#sessionRoutes.get(sessionId);

    if (
      workerId !== undefined &&
      (!this.#records.has(workerId) ||
        this.#record(workerId).status === "exited")
    ) {
      this.#sessionRoutes.delete(sessionId!);
      workerId = undefined;
    }

    workerId ??= this.#activeWorkerId;

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
    if (!sessionId) return;

    const record = this.#records.get(workerId);
    if (record === undefined || record.status === "exited") {
      return;
    }

    const previousId = this.#sessionRoutes.get(sessionId);
    if (previousId !== undefined && previousId !== workerId) {
      this.#records.get(previousId)?.sessions.delete(sessionId);
    }

    this.#sessionRoutes.set(sessionId, workerId);
    record.sessions.add(sessionId);
  }

  releaseSession(sessionId: string): void {
    const workerId = this.#sessionRoutes.get(sessionId);
    if (workerId === undefined) return;

    this.#sessionRoutes.delete(sessionId);
    const record = this.#records.get(workerId);
    record?.sessions.delete(sessionId);

    if (record !== undefined) {
      this.#maybeReap(record);
    }
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
          sessions: record.sessions.size,
          inFlight: record.inFlight,
        }))
        .sort((left, right) =>
          left.startedAt.localeCompare(right.startedAt),
        ),
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

    this.#sessionRoutes.clear();
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
    let check: SourceCheckResult;
    try {
      check = await this.#validate();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.#lastFailure = `source_check_failed: ${message}`;
      return {
        promoted: false,
        reason: this.#lastFailure,
      };
    }

    this.#lastCheck = check;

    if (!check.ok) {
      this.#lastFailure =
        `source_check_failed: exit=${String(check.exitCode)} signal=${String(check.signal)}`;
      return {
        promoted: false,
        reason: this.#lastFailure,
      };
    }

    let candidate: ManagedWorker;
    try {
      candidate = await this.#spawnWorker();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.#lastFailure = `candidate_startup_failed: ${message}`;
      return {
        promoted: false,
        reason: this.#lastFailure,
      };
    }

    const previousId = this.#activeWorkerId;
    this.#register(candidate, "active");
    this.#activeWorkerId = candidate.id;
    this.#lastFailure = undefined;

    if (
      previousId !== undefined &&
      previousId !== candidate.id
    ) {
      const previous = this.#records.get(previousId);
      if (previous !== undefined && previous.status !== "exited") {
        previous.status = "retiring";
        previous.retiredAt = new Date().toISOString();
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
      sessions: new Set(),
      promotedAt: new Date().toISOString(),
      status,
      inFlight: 0,
    };

    this.#records.set(worker.id, record);

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

    for (const sessionId of record.sessions) {
      this.#sessionRoutes.delete(sessionId);
    }
    record.sessions.clear();

    if (this.#activeWorkerId !== workerId) {
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
      return;
    }

    if (fallback.retireTimer !== undefined) {
      clearTimeout(fallback.retireTimer);
      fallback.retireTimer = undefined;
    }
    fallback.status = "active";
    fallback.retiredAt = undefined;
    fallback.promotedAt = new Date().toISOString();
    this.#activeWorkerId = fallback.worker.id;
    this.#lastFailure =
      `active_worker_exited_rolled_back_to: ${fallback.worker.id}`;
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

    if (record.inFlight > 0 || record.sessions.size > 0) {
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
