import type { ChildProcess } from "node:child_process";
import type { StringDecoder } from "node:string_decoder";
import type {
  PersistedJobMetadata,
  PersistedJobRecord,
} from "./job-history-store.js";
import type {
  JobSnapshot,
  JobStatus,
} from "./job-manager-types.js";

const MAX_CAPTURE_CHARS = 4 * 1024 * 1024;

export interface JobRecord {
  readonly id: string;
  readonly workspace: string;
  readonly key: string;
  readonly child: ChildProcess;
  readonly startedAt: string;
  readonly stdoutDecoder: StringDecoder;
  readonly stderrDecoder: StringDecoder;
  readonly completion: Promise<void>;
  resolveCompletion(): void;

  status: JobStatus;
  endedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  message?: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  cancelRequested: boolean;
  settled: boolean;
}

export function terminal(status: JobStatus): boolean {
  return status !== "running";
}

export function appendCaptured(
  current: string,
  addition: string,
): { value: string; truncated: boolean } {
  if (addition.length === 0) {
    return {
      value: current,
      truncated: false,
    };
  }

  const remaining = MAX_CAPTURE_CHARS - current.length;
  if (remaining <= 0) {
    return {
      value: current,
      truncated: true,
    };
  }

  if (addition.length <= remaining) {
    return {
      value: current + addition,
      truncated: false,
    };
  }

  return {
    value: current + addition.slice(0, remaining),
    truncated: true,
  };
}

export async function waitForCompletion(
  record: JobRecord,
  timeoutMs: number,
): Promise<void> {
  if (terminal(record.status)) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    void record.completion.then(finish);
  });
}

export function snapshot(record: JobRecord): JobSnapshot {
  return {
    id: record.id,
    workspace: record.workspace,
    key: record.key,
    status: record.status,
    pid: record.child.pid ?? null,
    startedAt: record.startedAt,
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.signal === undefined ? {} : { signal: record.signal }),
    ...(record.message === undefined ? {} : { message: record.message }),
    stdoutChars: record.stdout.length,
    stderrChars: record.stderr.length,
    stdoutTruncated: record.stdoutTruncated,
    stderrTruncated: record.stderrTruncated,
  };
}

export function persistedSnapshot(
  record: PersistedJobMetadata,
): JobSnapshot {
  return {
    id: record.id,
    workspace: record.workspace,
    key: record.key,
    status: record.status,
    pid: record.pid,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    ...(record.exitCode === undefined
      ? {}
      : { exitCode: record.exitCode }),
    ...(record.signal === undefined
      ? {}
      : { signal: record.signal }),
    ...(record.message === undefined
      ? {}
      : { message: record.message }),
    stdoutChars: record.stdoutChars,
    stderrChars: record.stderrChars,
    stdoutTruncated: record.stdoutTruncated,
    stderrTruncated: record.stderrTruncated,
  };
}

export function persistedRecord(
  record: JobRecord,
): PersistedJobRecord | undefined {
  if (
    record.status === "running" ||
    record.endedAt === undefined
  ) {
    return undefined;
  }

  return {
    version: 1,
    id: record.id,
    workspace: record.workspace,
    key: record.key,
    status: record.status,
    pid: record.child.pid ?? null,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    ...(record.exitCode === undefined
      ? {}
      : { exitCode: record.exitCode }),
    ...(record.signal === undefined
      ? {}
      : { signal: record.signal }),
    ...(record.message === undefined
      ? {}
      : { message: record.message }),
    stdoutChars: record.stdout.length,
    stderrChars: record.stderr.length,
    stdout: record.stdout,
    stderr: record.stderr,
    stdoutTruncated: record.stdoutTruncated,
    stderrTruncated: record.stderrTruncated,
  };
}



