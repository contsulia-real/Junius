import {
  WorkerResourceAffinity,
  type ResourceBindingState,
} from "./worker-resource-affinity.js";
import { WorkerSessionAffinity } from "./worker-session-affinity.js";

export interface WorkerAffinityRegistryOptions {
  readonly browserResourceIdleMs?: number;
  readonly desktopResourceIdleMs?: number;
  readonly jobResultRetentionMs?: number;
  readonly mcpSessionIdleMs?: number;
  readonly isWorkerAvailable: (workerId: string) => boolean;
  readonly onAffinityReleased?: (workerId: string) => void;
}

export type { ResourceBindingState } from "./worker-resource-affinity.js";

export class WorkerAffinityRegistry {
  readonly #sessions: WorkerSessionAffinity;
  readonly #resources: WorkerResourceAffinity;

  constructor(options: WorkerAffinityRegistryOptions) {
    this.#sessions = new WorkerSessionAffinity({
      idleMs: options.mcpSessionIdleMs,
      isWorkerAvailable: options.isWorkerAvailable,
      onAffinityReleased: options.onAffinityReleased,
    });
    this.#resources = new WorkerResourceAffinity({
      browserIdleMs: options.browserResourceIdleMs,
      desktopIdleMs: options.desktopResourceIdleMs,
      jobResultRetentionMs: options.jobResultRetentionMs,
      isWorkerAvailable: options.isWorkerAvailable,
      onAffinityReleased: options.onAffinityReleased,
    });
  }

  resolve(
    sessionId?: string,
    resourceKey?: string,
  ): string | undefined {
    return (
      this.#resources.resolve(resourceKey) ??
      this.#sessions.resolve(sessionId)
    );
  }

  bindSession(sessionId: string, workerId: string): void {
    this.#sessions.bind(sessionId, workerId);
  }

  releaseSession(sessionId: string): void {
    this.#sessions.release(sessionId);
  }

  bindResource(resourceKey: string, workerId: string): void {
    this.#resources.bind(resourceKey, workerId);
  }

  releaseResource(resourceKey: string): void {
    this.#resources.release(resourceKey);
  }

  markJobTerminal(workerId: string, jobId: string): void {
    this.#resources.markJobTerminal(workerId, jobId);
  }

  markJobHistoryPersisted(
    workerId: string,
    jobId: string,
  ): void {
    this.#resources.markJobHistoryPersisted(
      workerId,
      jobId,
    );
  }

  retireWorker(workerId: string): void {
    this.#sessions.retireWorker(workerId);
  }

  activateWorker(workerId: string): void {
    this.#sessions.activateWorker(workerId);
  }

  removeWorker(workerId: string): void {
    this.#sessions.removeWorker(workerId);
    this.#resources.removeWorker(workerId);
  }

  sessionCount(workerId: string): number {
    return this.#sessions.count(workerId);
  }

  resourceCount(workerId: string): number {
    return this.#resources.count(workerId);
  }

  hasAffinity(workerId: string): boolean {
    return (
      this.#sessions.has(workerId) ||
      this.#resources.has(workerId)
    );
  }

  resourceBindings(): readonly ResourceBindingState[] {
    return this.#resources.bindings();
  }

  close(): void {
    this.#sessions.close();
    this.#resources.close();
  }
}
