export type JobStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type JobManagerErrorCode =
  | "job_not_found"
  | "workspace_not_registered"
  | "spawn_failed";

export class JobManagerError
  extends Error {
  constructor(
    readonly code:
      JobManagerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface JobSnapshot {
  readonly id: string;
  readonly workspace: string;
  readonly executable: string;
  readonly status: JobStatus;
  readonly pid: number | null;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly exitCode?:
    number | null;
  readonly signal?:
    NodeJS.Signals | null;
  readonly message?: string;
  readonly stdoutChars: number;
  readonly stderrChars: number;
  readonly stdoutTruncated:
    boolean;
  readonly stderrTruncated:
    boolean;
}
