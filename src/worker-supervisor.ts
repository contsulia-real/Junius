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
  readonly resources: Set<string>;
  promotedAt: string;
  retiredAt?: string;
  status: WorkerStatus;
  inFlight: number;
  retireTimer?: NodeJS.Timeout;
}

interface ResourceBinding {
  readonly key: string;
  workerId: string;
  readonly boundAt: string;
  lastUsedAt: string;
  ttlMs?: number;
  expiresAt?: string;
  timer?: NodeJS.Timeout;
}

interface JobTerminalMessage {
  readonly type: "junius-job-terminal";
  readonly workerId: string;
  readonly jobId: string;
}

interface JobHistoryPersistedMessage {
  readonly type: "junius-job-history-persisted";
  readonly workerId: string;
  readonly jobId: string;
}

const DEFAULT_BROWSER_RESOURCE_IDLE_MS = 10 * 60_000;
const DEFAULT_DESKTOP_RESOURCE_IDLE_MS = 5 * 60_000;
const DEFAULT_JOB_RESULT_RETENTION_MS = 30 * 60_000;
const DEFAULT_MCP_SESSION_IDLE_MS = 30 * 60_000;
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
  readonly #sessionRoutes = new Map<string, string>();
  readonly #resourceRoutes = new Map<string, ResourceBinding>();
  readonly #terminalResourceHints = new Map<string, string>();
  readonly #persistedResourceHints = new Map<string, string>();
  readonly #hintTimers = new Map<string, NodeJS.Timeout>();
  readonly #sessionTimers = new Map<string, NodeJS.Timeout>();
  readonly #rollbackWindowMs: number;
  readonly #browserResourceIdleMs: number;
  readonly #desktopResourceIdleMs: number;
  readonly #jobResultRetentionMs: number;
  readonly #mcpSessionIdleMs: number;
  readonly #maxExitedRecords: number;
  readonly #canPromote: () => boolean;
  readonly #validate: () => Promise<SourceCheckResult>;
  readonly #spawnWorker: () => Promise<ManagedWorker>;
  readonly #spawnInitialWorker: () => Promise<ManagedWorker>;

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
    this.#browserResourceIdleMs =
      options.browserResourceIdleMs ??
      DEFAULT_BROWSER_RESOURCE_IDLE_MS;
    this.#desktopResourceIdleMs =
      options.desktopResourceIdleMs ??
      DEFAULT_DESKTOP_RESOURCE_IDLE_MS;
    this.#jobResultRetentionMs =
      options.jobResultRetentionMs ??
      DEFAULT_JOB_RESULT_RETENTION_MS;
    this.#mcpSessionIdleMs =
      options.mcpSessionIdleMs ??
      DEFAULT_MCP_SESSION_IDLE_MS;
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

  acquire(
    sessionId?: string,
    resourceKey?: string,
  ): WorkerLease {
    let resourceBinding =
      resourceKey === undefined
        ? undefined
        : this.#resourceRoutes.get(resourceKey);

    if (
      resourceBinding !== undefined &&
      this.#resourceExpired(resourceBinding)
    ) {
      this.#releaseResourceBinding(resourceBinding);
      resourceBinding = undefined;
    }

    let workerId = resourceBinding?.workerId;

    if (
      workerId !== undefined &&
      (!this.#records.has(workerId) ||
        this.#record(workerId).status === "exited")
    ) {
      if (resourceBinding !== undefined) {
        this.#releaseResourceBinding(resourceBinding);
        resourceBinding = undefined;
      }
      workerId = undefined;
    }

    if (resourceBinding !== undefined) {
      this.#touchResourceBinding(resourceBinding);
    }

    if (workerId === undefined && sessionId !== undefined) {
      workerId = this.#sessionRoutes.get(sessionId);

      if (
        workerId !== undefined &&
        (!this.#records.has(workerId) ||
          this.#record(workerId).status === "exited")
      ) {
        this.#clearSessionTimer(sessionId);
        this.#sessionRoutes.delete(sessionId);
        workerId = undefined;
      } else if (workerId !== undefined) {
        this.#armSessionExpiry(sessionId, workerId);
      }
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

    this.#armSessionExpiry(sessionId, workerId);
  }

  releaseSession(sessionId: string): void {
    const workerId = this.#sessionRoutes.get(sessionId);
    if (workerId === undefined) return;

    this.#clearSessionTimer(sessionId);
    this.#sessionRoutes.delete(sessionId);
    const record = this.#records.get(workerId);
    record?.sessions.delete(sessionId);

    if (record !== undefined) {
      this.#maybeReap(record);
    }
  }

  bindResource(resourceKey: string, workerId: string): void {
    if (!resourceKey) return;

    const record = this.#records.get(workerId);
    if (record === undefined || record.status === "exited") {
      return;
    }

    if (
      resourceKey.startsWith("job:") &&
      this.#persistedResourceHints.get(resourceKey) ===
        workerId
    ) {
      this.#deleteHint(
        this.#persistedResourceHints,
        "persisted",
        resourceKey,
      );
      this.#deleteHint(
        this.#terminalResourceHints,
        "terminal",
        resourceKey,
      );

      const existingPersisted =
        this.#resourceRoutes.get(resourceKey);
      if (
        existingPersisted !== undefined &&
        existingPersisted.workerId === workerId
      ) {
        this.#releaseResourceBinding(
          existingPersisted,
        );
      }
      return;
    }

    const previous = this.#resourceRoutes.get(resourceKey);
    if (
      previous !== undefined &&
      previous.workerId !== workerId
    ) {
      this.#releaseResourceBinding(previous);
    }

    const existing = this.#resourceRoutes.get(resourceKey);
    if (existing !== undefined) {
      this.#touchResourceBinding(existing);
      return;
    }

    const now = new Date().toISOString();
    const binding: ResourceBinding = {
      key: resourceKey,
      workerId,
      boundAt: now,
      lastUsedAt: now,
    };

    this.#resourceRoutes.set(resourceKey, binding);
    record.resources.add(resourceKey);

    const defaultTtl = this.#resourceIdleTtl(resourceKey);
    if (defaultTtl !== undefined) {
      this.#armResourceExpiry(binding, defaultTtl);
    }

    if (
      resourceKey.startsWith("job:") &&
      this.#terminalResourceHints.get(resourceKey) === workerId
    ) {
      this.#deleteHint(
        this.#terminalResourceHints,
        "terminal",
        resourceKey,
      );
      this.#armResourceExpiry(
        binding,
        this.#jobResultRetentionMs,
      );
    }
  }

  releaseResource(resourceKey: string): void {
    const binding = this.#resourceRoutes.get(resourceKey);
    if (binding === undefined) return;
    this.#releaseResourceBinding(binding);
  }

  markJobTerminal(workerId: string, jobId: string): void {
    const resourceKey = `job:${jobId}`;

    if (
      this.#persistedResourceHints.get(resourceKey) ===
      workerId
    ) {
      return;
    }

    const binding = this.#resourceRoutes.get(resourceKey);

    if (
      binding === undefined ||
      binding.workerId !== workerId
    ) {
      this.#setHint(
        this.#terminalResourceHints,
        "terminal",
        resourceKey,
        workerId,
      );
      return;
    }

    this.#deleteHint(
      this.#terminalResourceHints,
      "terminal",
      resourceKey,
    );
    this.#armResourceExpiry(
      binding,
      this.#jobResultRetentionMs,
    );
  }

  markJobHistoryPersisted(
    workerId: string,
    jobId: string,
  ): void {
    const resourceKey = `job:${jobId}`;
    const binding = this.#resourceRoutes.get(resourceKey);

    this.#deleteHint(
      this.#terminalResourceHints,
      "terminal",
      resourceKey,
    );

    if (
      binding === undefined ||
      binding.workerId !== workerId
    ) {
      this.#setHint(
        this.#persistedResourceHints,
        "persisted",
        resourceKey,
        workerId,
      );
      return;
    }

    this.#deleteHint(
      this.#persistedResourceHints,
      "persisted",
      resourceKey,
    );
    this.#releaseResourceBinding(binding);
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
          resources: record.resources.size,
          inFlight: record.inFlight,
        }))
        .sort((left, right) =>
          left.startedAt.localeCompare(right.startedAt),
        ),
      resourceBindings: [...this.#resourceRoutes.values()]
        .map((binding) => ({
          key: binding.key,
          workerId: binding.workerId,
          boundAt: binding.boundAt,
          lastUsedAt: binding.lastUsedAt,
          ...(binding.expiresAt === undefined
            ? {}
            : { expiresAt: binding.expiresAt }),
        }))
        .sort((left, right) =>
          left.key.localeCompare(right.key),
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

    for (const timer of this.#sessionTimers.values()) {
      clearTimeout(timer);
    }
    this.#sessionTimers.clear();
    this.#sessionRoutes.clear();

    for (const timer of this.#hintTimers.values()) {
      clearTimeout(timer);
    }
    this.#hintTimers.clear();

    for (const binding of this.#resourceRoutes.values()) {
      if (binding.timer !== undefined) {
        clearTimeout(binding.timer);
      }
    }
    this.#resourceRoutes.clear();
    this.#terminalResourceHints.clear();
    this.#persistedResourceHints.clear();
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
    if (!this.#canPromote()) {
      this.#lastFailure =
        "candidate_promotion_blocked";
      return {
        promoted: false,
        reason: this.#lastFailure,
      };
    }

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

    if (!this.#canPromote()) {
      this.#lastFailure =
        "candidate_promotion_blocked";
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

    if (!this.#canPromote()) {
      await candidate.close().catch(() => {});
      this.#lastFailure =
        "candidate_promotion_blocked";
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
        for (const sessionId of previous.sessions) {
          this.#armSessionExpiry(
            sessionId,
            previous.worker.id,
          );
        }
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
      resources: new Set(),
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

    for (const sessionId of record.sessions) {
      this.#clearSessionTimer(sessionId);
      this.#sessionRoutes.delete(sessionId);
    }
    record.sessions.clear();

    for (const resourceKey of [...record.resources]) {
      const binding = this.#resourceRoutes.get(resourceKey);
      if (binding !== undefined) {
        this.#releaseResourceBinding(binding);
      }
    }
    record.resources.clear();

    for (const [resourceKey, hintedWorkerId] of
      this.#terminalResourceHints
    ) {
      if (hintedWorkerId === workerId) {
        this.#deleteHint(
          this.#terminalResourceHints,
          "terminal",
          resourceKey,
        );
      }
    }

    for (const [resourceKey, hintedWorkerId] of
      this.#persistedResourceHints
    ) {
      if (hintedWorkerId === workerId) {
        this.#deleteHint(
          this.#persistedResourceHints,
          "persisted",
          resourceKey,
        );
      }
    }

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
    for (const sessionId of fallback.sessions) {
      this.#clearSessionTimer(sessionId);
    }
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

  #hintTimerKey(
    kind: "terminal" | "persisted",
    resourceKey: string,
  ): string {
    return `${kind}:${resourceKey}`;
  }

  #setHint(
    map: Map<string, string>,
    kind: "terminal" | "persisted",
    resourceKey: string,
    workerId: string,
  ): void {
    this.#deleteHint(map, kind, resourceKey);
    map.set(resourceKey, workerId);

    const timerKey =
      this.#hintTimerKey(kind, resourceKey);
    const timer = setTimeout(() => {
      this.#hintTimers.delete(timerKey);
      if (map.get(resourceKey) === workerId) {
        map.delete(resourceKey);
      }
    }, this.#jobResultRetentionMs);

    this.#hintTimers.set(timerKey, timer);
  }

  #deleteHint(
    map: Map<string, string>,
    kind: "terminal" | "persisted",
    resourceKey: string,
  ): void {
    map.delete(resourceKey);

    const timerKey =
      this.#hintTimerKey(kind, resourceKey);
    const timer = this.#hintTimers.get(timerKey);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#hintTimers.delete(timerKey);
    }
  }

  #clearSessionTimer(sessionId: string): void {
    const timer = this.#sessionTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#sessionTimers.delete(sessionId);
    }
  }

  #armSessionExpiry(
    sessionId: string,
    workerId: string,
  ): void {
    this.#clearSessionTimer(sessionId);

    const timer = setTimeout(() => {
      this.#sessionTimers.delete(sessionId);

      if (
        this.#sessionRoutes.get(sessionId) !== workerId
      ) {
        return;
      }

      const record = this.#records.get(workerId);
      if (
        record === undefined ||
        record.status === "exited"
      ) {
        return;
      }

      this.releaseSession(sessionId);
    }, this.#mcpSessionIdleMs);

    this.#sessionTimers.set(sessionId, timer);
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

  #resourceIdleTtl(
    resourceKey: string,
  ): number | undefined {
    if (resourceKey.startsWith("browser:")) {
      return this.#browserResourceIdleMs;
    }
    if (resourceKey.startsWith("desktop:")) {
      return this.#desktopResourceIdleMs;
    }
    return undefined;
  }

  #resourceExpired(binding: ResourceBinding): boolean {
    if (binding.expiresAt === undefined) return false;
    return Date.parse(binding.expiresAt) <= Date.now();
  }

  #touchResourceBinding(binding: ResourceBinding): void {
    binding.lastUsedAt = new Date().toISOString();

    if (binding.ttlMs !== undefined) {
      this.#armResourceExpiry(binding, binding.ttlMs);
    }
  }

  #armResourceExpiry(
    binding: ResourceBinding,
    ttlMs: number,
  ): void {
    if (binding.timer !== undefined) {
      clearTimeout(binding.timer);
    }

    const boundedTtl = Math.max(1, Math.floor(ttlMs));
    const now = Date.now();
    binding.ttlMs = boundedTtl;
    binding.lastUsedAt = new Date(now).toISOString();
    binding.expiresAt = new Date(now + boundedTtl).toISOString();

    const expectedWorkerId = binding.workerId;
    binding.timer = setTimeout(() => {
      binding.timer = undefined;
      const current = this.#resourceRoutes.get(binding.key);
      if (
        current !== binding ||
        current.workerId !== expectedWorkerId
      ) {
        return;
      }

      this.#releaseResourceBinding(binding);
    }, boundedTtl);
  }

  #releaseResourceBinding(binding: ResourceBinding): void {
    const current = this.#resourceRoutes.get(binding.key);
    if (current !== binding) return;

    if (binding.timer !== undefined) {
      clearTimeout(binding.timer);
      binding.timer = undefined;
    }

    this.#resourceRoutes.delete(binding.key);
    this.#deleteHint(
      this.#terminalResourceHints,
      "terminal",
      binding.key,
    );
    this.#deleteHint(
      this.#persistedResourceHints,
      "persisted",
      binding.key,
    );

    const record = this.#records.get(binding.workerId);
    record?.resources.delete(binding.key);

    if (record !== undefined) {
      this.#maybeReap(record);
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
      record.sessions.size > 0 ||
      record.resources.size > 0
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
