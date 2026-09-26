import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { isProcessPreparableCapability } from "./capabilities/types.js";
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

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const pid = child.pid;
  if (pid === undefined) {
    child.kill();
    return;
  }

  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    const taskkill = join(systemRoot, "System32", "taskkill.exe");

    await new Promise<void>((resolve) => {
      let killer: ChildProcess;
      try {
        killer = spawn(
          taskkill,
          ["/PID", String(pid), "/T", "/F"],
          {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          },
        );
      } catch {
        child.kill();
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      killer.once("error", () => {
        child.kill();
        finish();
      });
      killer.once("close", finish);
    });

    return;
  }

  child.kill("SIGTERM");

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);

    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export class JobManager {
  readonly #jobs = new Map<string, JobRecord>();

  constructor(private readonly commands: RunCommandService) {}

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

  get(id: string): JobSnapshot {
    return snapshot(this.#require(id));
  }

  async wait(
    id: string,
    timeoutMs = DEFAULT_WAIT_MS,
  ): Promise<JobSnapshot> {
    const record = this.#require(id);
    if (terminal(record.status)) {
      return snapshot(record);
    }

    const boundedTimeout = Math.max(
      0,
      Math.min(timeoutMs, MAX_WAIT_MS),
    );

    await Promise.race([
      record.completion,
      new Promise<void>((resolve) => {
        setTimeout(resolve, boundedTimeout);
      }),
    ]);

    return snapshot(record);
  }

  readOutput(
    id: string,
    stream: "stdout" | "stderr",
    offset = 0,
    limit = DEFAULT_READ_CHARS,
  ): {
    readonly job: JobSnapshot;
    readonly stream: "stdout" | "stderr";
    readonly offset: number;
    readonly nextOffset: number;
    readonly content: string;
    readonly eof: boolean;
    readonly truncated: boolean;
  } {
    const record = this.#require(id);
    const text = stream === "stdout" ? record.stdout : record.stderr;
    const truncated =
      stream === "stdout"
        ? record.stdoutTruncated
        : record.stderrTruncated;

    const safeOffset = Math.max(0, Math.min(offset, text.length));
    const safeLimit = Math.max(1, Math.min(limit, MAX_READ_CHARS));
    const nextOffset = Math.min(text.length, safeOffset + safeLimit);

    return {
      job: snapshot(record),
      stream,
      offset: safeOffset,
      nextOffset,
      content: text.slice(safeOffset, nextOffset),
      eof: terminal(record.status) && nextOffset >= text.length,
      truncated,
    };
  }

  async cancel(id: string): Promise<JobSnapshot> {
    const record = this.#require(id);
    if (terminal(record.status)) {
      return snapshot(record);
    }

    record.cancelRequested = true;
    await terminateProcessTree(record.child);

    await Promise.race([
      record.completion,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 5_000);
      }),
    ]);

    return snapshot(record);
  }

  async close(): Promise<void> {
    const running = [...this.#jobs.values()].filter(
      (record) => record.status === "running",
    );

    await Promise.allSettled(
      running.map((record) => this.cancel(record.id)),
    );
  }

  #require(id: string): JobRecord {
    const record = this.#jobs.get(id);
    if (record === undefined) {
      throw new JobManagerError(
        "job_not_found",
        `Job is not registered in this Junius process: ${id}`,
      );
    }

    return record;
  }
}
