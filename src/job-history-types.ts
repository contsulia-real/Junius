export type PersistedJobStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface PersistedJobMetadata {
  readonly version: 2;
  readonly id: string;
  readonly workspace: string;
  readonly executable: string;
  readonly status:
    PersistedJobStatus;
  readonly pid: number | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly exitCode?:
    number | null;
  readonly signal?:
    NodeJS.Signals | null;
  readonly message?: string;
  readonly stdoutChars: number;
  readonly stderrChars: number;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly stdoutTruncated:
    boolean;
  readonly stderrTruncated:
    boolean;
}

export interface PersistedJobRecord
  extends PersistedJobMetadata {
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunningJobMarker {
  readonly version: 2;
  readonly id: string;
  readonly ownerWorkerId: string;
  readonly workspace: string;
  readonly executable: string;
  readonly startedAt: string;
}

export interface JobHistoryRetention {
  readonly maxEntries?: number;
  readonly maxAgeMs?: number;
}

export interface JobHistoryStats {
  readonly entries: number;
  readonly capturedBytes: number;
  readonly metadataCacheEntries:
    number;
  readonly metadataCacheLimit:
    number;
  readonly oldestEndedAt?: string;
  readonly newestEndedAt?: string;
  readonly retention:
    JobHistoryRetention;
}
