export type JobStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type JobManagerErrorCode =
  | "job_not_found"
  | "capability_not_job_startable"
  | "workspace_not_registered"
  | "capability_not_registered"
  | "capability_not_allowed"
  | "arguments_not_allowed_by_workspace"
  | "arguments_not_allowed"
  | "unsafe_repository_config"
  | "spawn_failed";

export class JobManagerError extends Error {
  constructor(
    readonly code: JobManagerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface JobSnapshot {
  readonly id: string;
  readonly workspace: string;
  readonly key: string;
  readonly status: JobStatus;
  readonly pid: number | null;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly message?: string;
  readonly stdoutChars: number;
  readonly stderrChars: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}
