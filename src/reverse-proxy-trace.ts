import type {
  TunnelHealthSnapshot,
} from "./tunnel-health.js";

export type HostTraceOutcome =
  | "completed"
  | "client_aborted"
  | "client_disconnected"
  | "request_rejected"
  | "no_active_worker"
  | "upstream_error"
  | "response_error"
  | "host_error";

export interface HostLatencyTraceEvent {
  readonly type: string;
  readonly at: string;
  readonly elapsedMs: number;
  readonly detail?: string;
}

export interface HostLatencyTrace {
  readonly traceId: string;
  readonly method?: string;
  readonly path?: string;
  readonly sessionId?: string;
  readonly tool?: string;
  readonly workerId?: string;
  readonly statusCode?: number;
  readonly state: "active" | "finished";
  readonly outcome?: HostTraceOutcome;
  readonly startedAt: string;
  readonly responseStartedAt?: string;
  readonly clientDisconnectedAt?: string;
  readonly hostTotalMs?: number;
  readonly workerDurationMs?: number;
  readonly proxyOverheadMs?: number;
  readonly completedAt?: string;
  readonly error?: string;
  readonly timeline: readonly HostLatencyTraceEvent[];
  readonly tunnelHealthAtStart?: TunnelHealthSnapshot;
  readonly tunnelHealthAtEnd?: TunnelHealthSnapshot;
}

type TunnelHealthProvider =
  () => TunnelHealthSnapshot | undefined;

type TraceAnnotation = Pick<
  HostLatencyTrace,
  | "tool"
  | "workerId"
  | "statusCode"
  | "workerDurationMs"
  | "responseStartedAt"
>;

function event(
  type: string,
  startedAtMs: number,
  detail?: string,
): HostLatencyTraceEvent {
  return {
    type,
    at: new Date().toISOString(),
    elapsedMs: Math.max(
      0,
      Math.round(performance.now() - startedAtMs),
    ),
    ...(detail === undefined ? {} : { detail }),
  };
}

export class HostLatencyTraceStore {
  readonly #limit: number;
  readonly #tunnelHealth?: TunnelHealthProvider;
  readonly #startedAtMs = new Map<string, number>();
  #entries: HostLatencyTrace[] = [];

  constructor(
    limit = 64,
    tunnelHealth?: TunnelHealthProvider,
  ) {
    this.#limit = Math.max(1, Math.floor(limit));
    this.#tunnelHealth = tunnelHealth;
  }

  start(
    traceId: string,
    input: {
      method?: string;
      path?: string;
      sessionId?: string;
    } = {},
  ): void {
    const startedAtMs = performance.now();
    this.#startedAtMs.set(traceId, startedAtMs);
    const tunnelHealthAtStart = this.#tunnelHealth?.();

    this.#entries.push({
      traceId,
      ...input,
      state: "active",
      startedAt: new Date().toISOString(),
      timeline: [event("request_started", startedAtMs)],
      ...(tunnelHealthAtStart === undefined
        ? {}
        : { tunnelHealthAtStart }),
    });
    this.#prune();
  }

  annotate(
    traceId: string,
    patch: TraceAnnotation,
  ): void {
    this.#replace(traceId, (trace) => ({
      ...trace,
      ...patch,
    }));
  }

  event(
    traceId: string,
    type: string,
    detail?: string,
  ): void {
    const startedAtMs =
      this.#startedAtMs.get(traceId) ??
      performance.now();

    this.#replace(traceId, (trace) => ({
      ...trace,
      timeline: [
        ...trace.timeline,
        event(type, startedAtMs, detail),
      ],
    }));
  }

  finish(
    traceId: string,
    outcome: HostTraceOutcome,
    statusCode?: number,
    error?: string,
  ): void {
    const startedAtMs = this.#startedAtMs.get(traceId);
    if (startedAtMs === undefined) return;

    const completedAt = new Date().toISOString();
    const hostTotalMs = Math.max(
      0,
      Math.round(performance.now() - startedAtMs),
    );
    const tunnelHealthAtEnd = this.#tunnelHealth?.();

    this.#replace(traceId, (trace) => {
      if (trace.state === "finished") return trace;

      return {
        ...trace,
        state: "finished",
        outcome,
        ...(statusCode === undefined ? {} : { statusCode }),
        ...(error === undefined ? {} : { error }),
        ...(outcome === "client_aborted" ||
        outcome === "client_disconnected"
          ? { clientDisconnectedAt: completedAt }
          : {}),
        hostTotalMs,
        ...(trace.workerDurationMs === undefined
          ? {}
          : {
              proxyOverheadMs: Math.max(
                0,
                hostTotalMs - trace.workerDurationMs,
              ),
            }),
        completedAt,
        timeline: [
          ...trace.timeline,
          event(
            "request_finished",
            startedAtMs,
            outcome,
          ),
        ],
        ...(tunnelHealthAtEnd === undefined
          ? {}
          : { tunnelHealthAtEnd }),
      };
    });
  }

  list(): readonly HostLatencyTrace[] {
    return [...this.#entries].reverse();
  }

  #replace(
    traceId: string,
    update: (trace: HostLatencyTrace) => HostLatencyTrace,
  ): void {
    const index = this.#entries.findIndex(
      (trace) => trace.traceId === traceId,
    );
    if (index < 0) return;
    this.#entries[index] = update(this.#entries[index]!);
  }

  #prune(): void {
    if (this.#entries.length <= this.#limit) return;

    const removed = this.#entries.splice(
      0,
      this.#entries.length - this.#limit,
    );
    for (const trace of removed) {
      this.#startedAtMs.delete(trace.traceId);
    }
  }
}
