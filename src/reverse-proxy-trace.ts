export interface HostLatencyTrace {
  readonly traceId: string;
  readonly tool?: string;
  readonly workerId?: string;
  readonly statusCode: number;
  readonly hostTotalMs: number;
  readonly workerDurationMs?: number;
  readonly proxyOverheadMs?: number;
  readonly completedAt: string;
}

export class HostLatencyTraceStore {
  readonly #limit: number;
  #entries: HostLatencyTrace[] = [];

  constructor(limit = 64) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  record(trace: HostLatencyTrace): void {
    this.#entries.push(trace);
    if (this.#entries.length > this.#limit) {
      this.#entries.splice(
        0,
        this.#entries.length - this.#limit,
      );
    }
  }

  list(): readonly HostLatencyTrace[] {
    return [...this.#entries].reverse();
  }
}
