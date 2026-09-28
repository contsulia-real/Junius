export interface WorkerJobIpcEvent {
  readonly type:
    | "terminal"
    | "history_persisted";
  readonly jobId: string;
}

const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseWorkerJobIpcEvent(
  workerId: string,
  message: unknown,
): WorkerJobIpcEvent | undefined {
  if (
    typeof message !== "object" ||
    message === null
  ) {
    return undefined;
  }

  const candidate = message as {
    readonly type?: string;
    readonly workerId?: string;
    readonly jobId?: string;
  };

  if (
    candidate.workerId !== workerId ||
    typeof candidate.jobId !== "string" ||
    !JOB_ID_PATTERN.test(candidate.jobId)
  ) {
    return undefined;
  }

  if (
    candidate.type ===
    "junius-job-terminal"
  ) {
    return {
      type: "terminal",
      jobId: candidate.jobId,
    };
  }

  if (
    candidate.type ===
    "junius-job-history-persisted"
  ) {
    return {
      type: "history_persisted",
      jobId: candidate.jobId,
    };
  }

  return undefined;
}
