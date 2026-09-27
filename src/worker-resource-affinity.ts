export interface WorkerResourceAffinityOptions {
  readonly browserIdleMs?: number;
  readonly desktopIdleMs?: number;
  readonly jobResultRetentionMs?: number;
  readonly isWorkerAvailable: (workerId: string) => boolean;
  readonly onAffinityReleased?: (workerId: string) => void;
}

export interface ResourceBindingState {
  readonly key: string;
  readonly workerId: string;
  readonly boundAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt?: string;
}

interface ResourceBinding {
  readonly key: string;
  readonly workerId: string;
  readonly boundAt: string;
  lastUsedAt: string;
  ttlMs?: number;
  expiresAt?: string;
  timer?: NodeJS.Timeout;
}

const DEFAULT_BROWSER_RESOURCE_IDLE_MS = 10 * 60_000;
const DEFAULT_DESKTOP_RESOURCE_IDLE_MS = 5 * 60_000;
const DEFAULT_JOB_RESULT_RETENTION_MS = 30 * 60_000;

export class WorkerResourceAffinity {
  readonly #routes = new Map<string, ResourceBinding>();
  readonly #terminalHints = new Map<string, string>();
  readonly #persistedHints = new Map<string, string>();
  readonly #hintTimers = new Map<string, NodeJS.Timeout>();
  readonly #browserIdleMs: number;
  readonly #desktopIdleMs: number;
  readonly #jobResultRetentionMs: number;
  readonly #isWorkerAvailable: (workerId: string) => boolean;
  readonly #onAffinityReleased?: (workerId: string) => void;

  constructor(options: WorkerResourceAffinityOptions) {
    this.#browserIdleMs =
      options.browserIdleMs ??
      DEFAULT_BROWSER_RESOURCE_IDLE_MS;
    this.#desktopIdleMs =
      options.desktopIdleMs ??
      DEFAULT_DESKTOP_RESOURCE_IDLE_MS;
    this.#jobResultRetentionMs =
      options.jobResultRetentionMs ??
      DEFAULT_JOB_RESULT_RETENTION_MS;
    this.#isWorkerAvailable = options.isWorkerAvailable;
    this.#onAffinityReleased = options.onAffinityReleased;
  }

  resolve(resourceKey?: string): string | undefined {
    if (resourceKey === undefined) {
      return undefined;
    }

    let binding = this.#routes.get(resourceKey);
    if (
      binding !== undefined &&
      this.#expired(binding)
    ) {
      this.#releaseBinding(binding);
      binding = undefined;
    }

    if (binding === undefined) {
      return undefined;
    }

    const workerId = binding.workerId;
    if (!this.#isWorkerAvailable(workerId)) {
      this.#releaseBinding(binding);
      return undefined;
    }

    this.#touch(binding);
    return workerId;
  }

  bind(resourceKey: string, workerId: string): void {
    if (!resourceKey || !this.#isWorkerAvailable(workerId)) {
      return;
    }

    if (
      resourceKey.startsWith("job:") &&
      this.#persistedHints.get(resourceKey) === workerId
    ) {
      this.#deleteHint(
        this.#persistedHints,
        "persisted",
        resourceKey,
      );
      this.#deleteHint(
        this.#terminalHints,
        "terminal",
        resourceKey,
      );

      const existingPersisted =
        this.#routes.get(resourceKey);
      if (
        existingPersisted !== undefined &&
        existingPersisted.workerId === workerId
      ) {
        this.#releaseBinding(existingPersisted);
      }
      return;
    }

    const previous = this.#routes.get(resourceKey);
    if (
      previous !== undefined &&
      previous.workerId !== workerId
    ) {
      this.#releaseBinding(previous);
    }

    const existing = this.#routes.get(resourceKey);
    if (existing !== undefined) {
      this.#touch(existing);
      return;
    }

    const now = new Date().toISOString();
    const binding: ResourceBinding = {
      key: resourceKey,
      workerId,
      boundAt: now,
      lastUsedAt: now,
    };
    this.#routes.set(resourceKey, binding);

    const defaultTtl = this.#idleTtl(resourceKey);
    if (defaultTtl !== undefined) {
      this.#armExpiry(binding, defaultTtl);
    }

    if (
      resourceKey.startsWith("job:") &&
      this.#terminalHints.get(resourceKey) === workerId
    ) {
      this.#deleteHint(
        this.#terminalHints,
        "terminal",
        resourceKey,
      );
      this.#armExpiry(
        binding,
        this.#jobResultRetentionMs,
      );
    }
  }

  release(resourceKey: string): void {
    const binding = this.#routes.get(resourceKey);
    if (binding === undefined) return;
    this.#releaseBinding(binding);
  }

  markJobTerminal(workerId: string, jobId: string): void {
    const resourceKey = `job:${jobId}`;

    if (this.#persistedHints.get(resourceKey) === workerId) {
      return;
    }

    const binding = this.#routes.get(resourceKey);
    if (
      binding === undefined ||
      binding.workerId !== workerId
    ) {
      this.#setHint(
        this.#terminalHints,
        "terminal",
        resourceKey,
        workerId,
      );
      return;
    }

    this.#deleteHint(
      this.#terminalHints,
      "terminal",
      resourceKey,
    );
    this.#armExpiry(
      binding,
      this.#jobResultRetentionMs,
    );
  }

  markJobHistoryPersisted(
    workerId: string,
    jobId: string,
  ): void {
    const resourceKey = `job:${jobId}`;
    const binding = this.#routes.get(resourceKey);

    this.#deleteHint(
      this.#terminalHints,
      "terminal",
      resourceKey,
    );

    if (
      binding === undefined ||
      binding.workerId !== workerId
    ) {
      this.#setHint(
        this.#persistedHints,
        "persisted",
        resourceKey,
        workerId,
      );
      return;
    }

    this.#deleteHint(
      this.#persistedHints,
      "persisted",
      resourceKey,
    );
    this.#releaseBinding(binding);
  }

  removeWorker(workerId: string): void {
    for (const binding of [...this.#routes.values()]) {
      if (binding.workerId === workerId) {
        this.#releaseBinding(binding);
      }
    }

    for (const [resourceKey, hintedWorkerId] of
      this.#terminalHints
    ) {
      if (hintedWorkerId === workerId) {
        this.#deleteHint(
          this.#terminalHints,
          "terminal",
          resourceKey,
        );
      }
    }

    for (const [resourceKey, hintedWorkerId] of
      this.#persistedHints
    ) {
      if (hintedWorkerId === workerId) {
        this.#deleteHint(
          this.#persistedHints,
          "persisted",
          resourceKey,
        );
      }
    }
  }

  count(workerId: string): number {
    let count = 0;
    for (const binding of this.#routes.values()) {
      if (binding.workerId === workerId) count += 1;
    }
    return count;
  }

  has(workerId: string): boolean {
    return this.count(workerId) > 0;
  }

  bindings(): readonly ResourceBindingState[] {
    return [...this.#routes.values()]
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
      );
  }

  close(): void {
    for (const timer of this.#hintTimers.values()) {
      clearTimeout(timer);
    }
    this.#hintTimers.clear();

    for (const binding of this.#routes.values()) {
      if (binding.timer !== undefined) {
        clearTimeout(binding.timer);
      }
    }
    this.#routes.clear();
    this.#terminalHints.clear();
    this.#persistedHints.clear();
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

    const timerKey = this.#hintTimerKey(kind, resourceKey);
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

    const timerKey = this.#hintTimerKey(kind, resourceKey);
    const timer = this.#hintTimers.get(timerKey);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#hintTimers.delete(timerKey);
    }
  }

  #idleTtl(resourceKey: string): number | undefined {
    if (resourceKey.startsWith("browser:")) {
      return this.#browserIdleMs;
    }
    if (resourceKey.startsWith("desktop:")) {
      return this.#desktopIdleMs;
    }
    return undefined;
  }

  #expired(binding: ResourceBinding): boolean {
    if (binding.expiresAt === undefined) return false;
    return Date.parse(binding.expiresAt) <= Date.now();
  }

  #touch(binding: ResourceBinding): void {
    binding.lastUsedAt = new Date().toISOString();

    if (binding.ttlMs !== undefined) {
      this.#armExpiry(binding, binding.ttlMs);
    }
  }

  #armExpiry(
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
    binding.expiresAt =
      new Date(now + boundedTtl).toISOString();

    const expectedWorkerId = binding.workerId;
    binding.timer = setTimeout(() => {
      binding.timer = undefined;
      const current = this.#routes.get(binding.key);
      if (
        current !== binding ||
        current.workerId !== expectedWorkerId
      ) {
        return;
      }

      this.#releaseBinding(binding);
    }, boundedTtl);
  }

  #releaseBinding(binding: ResourceBinding): void {
    const current = this.#routes.get(binding.key);
    if (current !== binding) return;

    if (binding.timer !== undefined) {
      clearTimeout(binding.timer);
      binding.timer = undefined;
    }

    this.#routes.delete(binding.key);
    this.#deleteHint(
      this.#terminalHints,
      "terminal",
      binding.key,
    );
    this.#deleteHint(
      this.#persistedHints,
      "persisted",
      binding.key,
    );
    this.#onAffinityReleased?.(binding.workerId);
  }
}
