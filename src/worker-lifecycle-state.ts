import type { WorkerAffinityRegistry } from "./worker-affinity-registry.js";
import type {
  WorkerRecord,
  WorkerStatus,
} from "./worker-retirement.js";

export interface WorkerLifecycleState {
  readonly activeWorkerId?: string;
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
  readonly resourceBindings:
    ReturnType<
      WorkerAffinityRegistry["resourceBindings"]
    >;
}

export function buildWorkerLifecycleState(
  records: ReadonlyMap<
    string,
    WorkerRecord
  >,
  activeWorkerId:
    string | undefined,
  affinity: WorkerAffinityRegistry,
): WorkerLifecycleState {
  return {
    ...(activeWorkerId === undefined
      ? {}
      : { activeWorkerId }),
    workers: [...records.values()]
      .map((record) => ({
        id: record.worker.id,
        pid: record.worker.pid,
        status: record.status,
        startedAt:
          record.worker.startedAt,
        promotedAt:
          record.promotedAt,
        ...(record.retiredAt ===
        undefined
          ? {}
          : {
              retiredAt:
                record.retiredAt,
            }),
        sessions:
          affinity.sessionCount(
            record.worker.id,
          ),
        resources:
          affinity.resourceCount(
            record.worker.id,
          ),
        inFlight: record.inFlight,
      }))
      .sort((left, right) =>
        left.startedAt.localeCompare(
          right.startedAt,
        ),
      ),
    resourceBindings:
      affinity.resourceBindings(),
  };
}

export function requiredWorkerRecord(
  records: ReadonlyMap<
    string,
    WorkerRecord
  >,
  workerId: string,
): WorkerRecord {
  const record = records.get(workerId);
  if (record === undefined) {
    throw new Error(
      `worker_not_found: ${workerId}`,
    );
  }
  return record;
}
