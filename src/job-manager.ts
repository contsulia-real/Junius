import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { isProcessPreparableCapability } from "./capabilities/types.js";
import {
  JobHistoryStore,
  type PersistedJobMetadata,
  type PersistedJobRecord,
} from "./job-history-store.js";
import { terminateProcessTree } from "./process-termination.js";
import { RunCommandService } from "./run-command.js";

const MAX_CAPTURE_CHARS = 4 * 1024 * 1024;
const DEFAULT_READ_CHARS = 64 * 1024;
const MAX_READ_CHARS = 256 * 1024;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 60_000;

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

interface JobRecord {
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

function terminal(status: JobStatus): boolean {
  return status !== "running";
}

function appendCaptured(
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

async function waitForCompletion(
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

function snapshot(record: JobRecord): JobSnapshot {
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

function persistedSnapshot(
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

function persistedRecord(
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


export class JobManager {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #pendingPersistence = new Set<Promise<void>>();

  constructor(
    private readonly commands: RunCommandService,
    private readonly onTerminal?: (job: JobSnapshot) => void,
    private readonly history?: JobHistoryStore,
  ) {}

  start(
    workspace: string,
    key: string,
    args: readonly string[],
  ): JobSnapshot {
    const authorized = this.commands.authorize(workspace, key, args);
    if (!authorized.ok) {
      throw new JobManagerError(
        authorized.code,
        authorized.message,
      );
    }

    if (!isProcessPreparableCapability(authorized.capability)) {
      throw new JobManagerError(
        "capability_not_job_startable",
        `Capability does not support background jobs: ${key}`,
      );
    }

    const prepared = authorized.capability.prepareProcess(
      args,
      authorized.context,
    );

    if (!prepared.ok) {
      const code =
        prepared.execution.code === "arguments_not_allowed"
          ? "arguments_not_allowed"
          : "spawn_failed";

      throw new JobManagerError(code, prepared.execution.message);
    }

    let child: ChildProcess;
    try {
      child = spawn(
        prepared.process.executable,
        [...prepared.process.args],
        {
          cwd: prepared.process.cwd,
          env: prepared.process.env,
          shell: false,
          windowsHide: prepared.process.windowsHide,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      throw new JobManagerError(
        "spawn_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    const record: JobRecord = {
      id: randomUUID(),
      workspace,
      key,
      child,
      startedAt: new Date().toISOString(),
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      completion,
      resolveCompletion,
      status: "running",
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      cancelRequested: false,
      settled: false,
    };

    this.#jobs.set(record.id, record);

    const appendStdout = (text: string) => {
      const appended = appendCaptured(record.stdout, text);
      record.stdout = appended.value;
      record.stdoutTruncated ||= appended.truncated;
    };

    const appendStderr = (text: string) => {
      const appended = appendCaptured(record.stderr, text);
      record.stderr = appended.value;
      record.stderrTruncated ||= appended.truncated;
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      appendStdout(
        typeof chunk === "string"
          ? chunk
          : record.stdoutDecoder.write(chunk),
      );
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      appendStderr(
        typeof chunk === "string"
          ? chunk
          : record.stderrDecoder.write(chunk),
      );
    });

    const finish = (
      status: JobStatus,
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      message?: string,
    ) => {
      if (record.settled) {
        return;
      }

      record.settled = true;
      appendStdout(record.stdoutDecoder.end());
      appendStderr(record.stderrDecoder.end());
      record.status = status;
      record.endedAt = new Date().toISOString();
      record.exitCode = exitCode;
      record.signal = signal;
      record.message = message;
      record.resolveCompletion();
      this.#persistTerminal(record);

      try {
        this.onTerminal?.(snapshot(record));
      } catch {
        // Job completion must not be changed by observer failures.
      }
    };

    child.once("error", (error) => {
      finish(
        record.cancelRequested ? "cancelled" : "failed",
        null,
        null,
        error.message,
      );
    });

    child.once("close", (exitCode, signal) => {
      if (record.cancelRequested) {
        finish("cancelled", exitCode, signal);
        return;
      }

      if (exitCode === 0) {
        finish("succeeded", exitCode, signal);
        return;
      }

      finish(
        "failed",
        exitCode,
        signal,
        `Process exited with code ${String(exitCode)}.`,
      );
    });

    return snapshot(record);
  }

  async list(): Promise<readonly JobSnapshot[]> {
    const merged = new Map<string, JobSnapshot>();

    if (this.history !== undefined) {
      for (const record of await this.history.listMetadata()) {
        merged.set(record.id, persistedSnapshot(record));
      }
    }

    for (const record of this.#jobs.values()) {
      merged.set(record.id, snapshot(record));
    }

    return [...merged.values()].sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt),
    );
  }

  async get(id: string): Promise<JobSnapshot> {
    const record = this.#jobs.get(id);
    if (record !== undefined) {
      return snapshot(record);
    }

    return persistedSnapshot(
      await this.#loadPersistedMetadata(id),
    );
  }

  async wait(
    id: string,
    timeoutMs = DEFAULT_WAIT_MS,
  ): Promise<JobSnapshot> {
    const record = this.#jobs.get(id);
    if (record === undefined) {
      return persistedSnapshot(
        await this.#loadPersistedMetadata(id),
      );
    }

    if (terminal(record.status)) {
      return snapshot(record);
    }

    const boundedTimeout = Math.max(
      0,
      Math.min(timeoutMs, MAX_WAIT_MS),
    );

    await waitForCompletion(record, boundedTimeout);

    return snapshot(record);
  }

  async readOutput(
    id: string,
    stream: "stdout" | "stderr",
    offset = 0,
    limit = DEFAULT_READ_CHARS,
  ): Promise<{
    readonly job: JobSnapshot;
    readonly stream: "stdout" | "stderr";
    readonly offset: number;
    readonly nextOffset: number;
    readonly content: string;
    readonly eof: boolean;
    readonly truncated: boolean;
  }> {
    const live = this.#jobs.get(id);

    let job: JobSnapshot;
    let text: string;
    let truncated: boolean;
    let isTerminal: boolean;

    if (live !== undefined) {
      job = snapshot(live);
      text = stream === "stdout" ? live.stdout : live.stderr;
      truncated =
        stream === "stdout"
          ? live.stdoutTruncated
          : live.stderrTruncated;
      isTerminal = terminal(live.status);
    } else {
      const persisted = await this.#loadPersistedRecord(id);
      job = persistedSnapshot(persisted);
      text =
        stream === "stdout"
          ? persisted.stdout
          : persisted.stderr;
      truncated =
        stream === "stdout"
          ? persisted.stdoutTruncated
          : persisted.stderrTruncated;
      isTerminal = true;
    }

    const safeOffset = Math.max(
      0,
      Math.min(offset, text.length),
    );
    const safeLimit = Math.max(
      1,
      Math.min(limit, MAX_READ_CHARS),
    );
    const nextOffset = Math.min(
      text.length,
      safeOffset + safeLimit,
    );

    return {
      job,
      stream,
      offset: safeOffset,
      nextOffset,
      content: text.slice(safeOffset, nextOffset),
      eof: isTerminal && nextOffset >= text.length,
      truncated,
    };
  }

  async cancel(id: string): Promise<JobSnapshot> {
    const record = this.#jobs.get(id);
    if (record === undefined) {
      return persistedSnapshot(
        await this.#loadPersistedMetadata(id),
      );
    }

    if (terminal(record.status)) {
      return snapshot(record);
    }

    record.cancelRequested = true;
    await terminateProcessTree(record.child);

    await waitForCompletion(record, 5_000);

    return snapshot(record);
  }

  async close(): Promise<void> {
    const running = [...this.#jobs.values()].filter(
      (record) => record.status === "running",
    );

    await Promise.allSettled(
      running.map((record) => this.cancel(record.id)),
    );

    await Promise.allSettled([
      ...this.#pendingPersistence,
    ]);
  }

  #persistTerminal(record: JobRecord): void {
    if (this.history === undefined) {
      return;
    }

    const persisted = persistedRecord(record);
    if (persisted === undefined) {
      return;
    }

    const task = this.history.save(persisted).catch(
      (error: unknown) => {
        console.error(
          `[job-history ${record.id}]`,
          error,
        );
      },
    );

    this.#pendingPersistence.add(task);
    void task.finally(() => {
      this.#pendingPersistence.delete(task);
    });
  }

  async #loadPersistedMetadata(
    id: string,
  ): Promise<PersistedJobMetadata> {
    const record = await this.history?.loadMetadata(id);
    if (record !== undefined) {
      return record;
    }

    throw new JobManagerError(
      "job_not_found",
      `Job is not registered in this Junius process or terminal history: ${id}`,
    );
  }

  async #loadPersistedRecord(
    id: string,
  ): Promise<PersistedJobRecord> {
    const record = await this.history?.load(id);
    if (record !== undefined) {
      return record;
    }

    throw new JobManagerError(
      "job_not_found",
      `Job is not registered in this Junius process or terminal history: ${id}`,
    );
  }
}
