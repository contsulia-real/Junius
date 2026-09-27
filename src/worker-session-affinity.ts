export interface WorkerSessionAffinityOptions {
  readonly idleMs?: number;
  readonly isWorkerAvailable: (workerId: string) => boolean;
  readonly onAffinityReleased?: (workerId: string) => void;
}

const DEFAULT_MCP_SESSION_IDLE_MS = 30 * 60_000;

export class WorkerSessionAffinity {
  readonly #routes = new Map<string, string>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #idleMs: number;
  readonly #isWorkerAvailable: (workerId: string) => boolean;
  readonly #onAffinityReleased?: (workerId: string) => void;

  constructor(options: WorkerSessionAffinityOptions) {
    this.#idleMs =
      options.idleMs ?? DEFAULT_MCP_SESSION_IDLE_MS;
    this.#isWorkerAvailable = options.isWorkerAvailable;
    this.#onAffinityReleased = options.onAffinityReleased;
  }

  resolve(sessionId?: string): string | undefined {
    if (sessionId === undefined) {
      return undefined;
    }

    const workerId = this.#routes.get(sessionId);
    if (workerId === undefined) {
      return undefined;
    }

    if (!this.#isWorkerAvailable(workerId)) {
      this.#clearTimer(sessionId);
      this.#routes.delete(sessionId);
      return undefined;
    }

    this.#armExpiry(sessionId, workerId);
    return workerId;
  }

  bind(sessionId: string, workerId: string): void {
    if (!sessionId || !this.#isWorkerAvailable(workerId)) {
      return;
    }

    this.#routes.set(sessionId, workerId);
    this.#armExpiry(sessionId, workerId);
  }

  release(sessionId: string): void {
    const workerId = this.#routes.get(sessionId);
    if (workerId === undefined) return;

    this.#clearTimer(sessionId);
    this.#routes.delete(sessionId);
    this.#onAffinityReleased?.(workerId);
  }

  retireWorker(workerId: string): void {
    for (const [sessionId, routedWorkerId] of this.#routes) {
      if (routedWorkerId === workerId) {
        this.#armExpiry(sessionId, workerId);
      }
    }
  }

  activateWorker(workerId: string): void {
    for (const [sessionId, routedWorkerId] of this.#routes) {
      if (routedWorkerId === workerId) {
        this.#clearTimer(sessionId);
      }
    }
  }

  removeWorker(workerId: string): void {
    for (const [sessionId, routedWorkerId] of this.#routes) {
      if (routedWorkerId === workerId) {
        this.#clearTimer(sessionId);
        this.#routes.delete(sessionId);
      }
    }
  }

  count(workerId: string): number {
    let count = 0;
    for (const routedWorkerId of this.#routes.values()) {
      if (routedWorkerId === workerId) count += 1;
    }
    return count;
  }

  has(workerId: string): boolean {
    return this.count(workerId) > 0;
  }

  close(): void {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    this.#routes.clear();
  }

  #clearTimer(sessionId: string): void {
    const timer = this.#timers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(sessionId);
    }
  }

  #armExpiry(
    sessionId: string,
    workerId: string,
  ): void {
    this.#clearTimer(sessionId);

    const timer = setTimeout(() => {
      this.#timers.delete(sessionId);

      if (this.#routes.get(sessionId) !== workerId) {
        return;
      }

      if (!this.#isWorkerAvailable(workerId)) {
        this.#routes.delete(sessionId);
        return;
      }

      this.release(sessionId);
    }, this.#idleMs);

    this.#timers.set(sessionId, timer);
  }
}
