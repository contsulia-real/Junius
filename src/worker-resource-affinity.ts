import { WorkerJobAffinityHints } from "./worker-job-affinity-hints.js";

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
export class WorkerResourceAffinity {
  readonly #routes = new Map<string, ResourceBinding>();
  readonly #jobHints: WorkerJobAffinityHints;
  readonly #browserIdleMs: number;
  readonly #desktopIdleMs: number;
  readonly #isWorkerAvailable: (workerId: string) => boolean;
  readonly #onAffinityReleased?: (workerId: string) => void;

  constructor(options: WorkerResourceAffinityOptions) {
    this.#browserIdleMs =
      options.browserIdleMs ??
      DEFAULT_BROWSER_RESOURCE_IDLE_MS;
    this.#desktopIdleMs =
      options.desktopIdleMs ??
      DEFAULT_DESKTOP_RESOURCE_IDLE_MS;
    this.#jobHints =
      new WorkerJobAffinityHints(
        options.jobResultRetentionMs,
      );
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
      this.#jobHints.persistedMatches(
        resourceKey,
        workerId,
      )
    ) {
      this.#jobHints.clear(resourceKey);

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
      this.#jobHints.terminalMatches(
        resourceKey,
        workerId,
      )
    ) {
      this.#jobHints.clearTerminal(resourceKey);
      this.#armExpiry(
        binding,
        this.#jobHints.retentionMs,
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

    if (
      this.#jobHints.persistedMatches(
        resourceKey,
        workerId,
      )
    ) {
      return;
    }

    const binding = this.#routes.get(resourceKey);
    if (
      binding === undefined ||
      binding.workerId !== workerId
    ) {
      this.#jobHints.setTerminal(
        resourceKey,
        workerId,
      );
      return;
    }

    this.#jobHints.clearTerminal(resourceKey);
    this.#armExpiry(
      binding,
      this.#jobHints.retentionMs,
    );
  }

  markJobHistoryPersisted(
    workerId: string,
    jobId: string,
  ): void {
    const resourceKey = `job:${jobId}`;
    const binding = this.#routes.get(resourceKey);

    this.#jobHints.clearTerminal(resourceKey);

    if (
      binding === undefined ||
      binding.workerId !== workerId
    ) {
      this.#jobHints.setPersisted(
        resourceKey,
        workerId,
      );
      return;
    }

    this.#jobHints.clearPersisted(resourceKey);
    this.#releaseBinding(binding);
  }

  removeWorker(workerId: string): void {
    for (const binding of [...this.#routes.values()]) {
      if (binding.workerId === workerId) {
        this.#releaseBinding(binding);
      }
    }

    this.#jobHints.removeWorker(workerId);
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
    for (const binding of this.#routes.values()) {
      if (binding.timer !== undefined) {
        clearTimeout(binding.timer);
      }
    }
    this.#routes.clear();
    this.#jobHints.close();
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
    this.#jobHints.clear(binding.key);
    this.#onAffinityReleased?.(binding.workerId);
  }
}
