import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { AuditStore } from "./audit-store.js";
import type { JobHistoryStore } from "./job-history-store.js";
import {
  appendCaptured,
  snapshot,
  terminal,
  waitForCompletion,
  type JobRecord,
} from "./job-manager-runtime.js";
import {
  JobManagerError,
  type JobSnapshot,
  type JobStatus,
} from "./job-manager-types.js";
import { terminateProcessTree } from "./process-termination.js";
import { JobPersistenceCoordinator } from "./job-persistence.js";
import { spawnJobProcess } from "./job-process-controller.js";
import {
  JobQueryService,
  type JobOutputSlice,
} from "./job-query.js";
import { RunCommandService } from "./run-command.js";

export class JobManager {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #persistence: JobPersistenceCoordinator;
  readonly #queries: JobQueryService;

  constructor(
    private readonly commands: RunCommandService,
    private readonly onTerminal?: (job: JobSnapshot) => void,
    history?: JobHistoryStore,
    onPersisted?: (job: JobSnapshot) => void,
    private readonly audit?: AuditStore,
    private readonly ownerWorkerId =
      `direct-${process.pid}`,
  ) {
    this.#persistence =
      new JobPersistenceCoordinator(
        history,
        {
          onPersisted,
          afterPersisted: (record) => {
            if (
              this.#jobs.get(record.id) === record &&
              terminal(record.status)
            ) {
              this.#jobs.delete(record.id);
            }
          },
        },
      );
    this.#queries =
      new JobQueryService(
        this.#jobs,
        this.#persistence,
      );
  }

  async start(
    workspace: string,
    executable: string,
    args: readonly string[],
  ): Promise<JobSnapshot> {
    const prepared =
      this.commands.prepare(
        workspace,
        executable,
        args,
      );

    if (!prepared.ok) {
      this.audit?.record({
        category: "job",
        action: "start_job",
        status: "failed",
        workspace,
        subject: executable,
        summary: prepared.code,
        metadata: {
          argCount: args.length,
          code: prepared.code,
        },
      });
      throw new JobManagerError(
        prepared.code,
        prepared.message,
      );
    }

    const id = randomUUID();
    const startedAt =
      new Date().toISOString();

    await this.#persistence.markRunning({
      version: 2,
      id,
      ownerWorkerId:
        this.ownerWorkerId,
      workspace,
      executable,
      startedAt,
    });

    let processController;
    try {
      processController =
        await spawnJobProcess(
          prepared.process,
        );
    } catch (error) {
      await this.#persistence
        .clearRunning(id)
        .catch(() => undefined);

      throw new JobManagerError(
        "spawn_failed",
        error instanceof Error
          ? error.message
          : String(error),
      );
    }

    const {
      child,
      pid,
      stdout,
      stderr,
    } = processController;

    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    const record: JobRecord = {
      id,
      workspace,
      executable,
      child,
      pid,
      startedAt,
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

    this.audit?.record({
      category: "job",
      action: "start_job",
      status: "started",
      workspace,
      subject: executable,
      summary: "Background job started.",
      metadata: {
        job: record.id,
        pid: record.pid ?? -1,
        argCount: args.length,
      },
    });

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

    stdout.on("data", (chunk: Buffer | string) => {
      appendStdout(
        typeof chunk === "string"
          ? chunk
          : record.stdoutDecoder.write(chunk),
      );
    });

    stderr.on("data", (chunk: Buffer | string) => {
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
      this.#persistence.persist(record);

      this.audit?.record({
        category: "job",
        action: "job_terminal",
        status:
          status === "succeeded"
            ? "succeeded"
            : status === "cancelled"
              ? "cancelled"
              : "failed",
        workspace,
        subject: executable,
        summary: status,
        metadata: {
          job: record.id,
          argCount: args.length,
          exitCode:
            exitCode ?? -1,
          stdoutChars:
            record.stdout.length,
          stderrChars:
            record.stderr.length,
        },
      });

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

  async historyStats() {
    return this.#queries.historyStats();
  }

  async list(
    terminalLimit?: number,
  ): Promise<readonly JobSnapshot[]> {
    return this.#queries.list(
      terminalLimit,
    );
  }

  async get(
    id: string,
  ): Promise<JobSnapshot> {
    return this.#queries.get(id);
  }

  async wait(
    id: string,
    timeoutMs?: number,
  ): Promise<JobSnapshot> {
    return this.#queries.wait(
      id,
      timeoutMs,
    );
  }

  async readOutput(
    id: string,
    stream: "stdout" | "stderr",
    offset?: number,
    limit?: number,
  ): Promise<JobOutputSlice> {
    return this.#queries.readOutput(
      id,
      stream,
      offset,
      limit,
    );
  }

  async cancel(id: string): Promise<JobSnapshot> {
    const record = this.#jobs.get(id);
    if (record === undefined) {
      return this.#queries.get(id);
    }

    if (terminal(record.status)) {
      return snapshot(record);
    }

    record.cancelRequested = true;
    await terminateProcessTree(record.child);

    await waitForCompletion(record, 5_000);

    const result = snapshot(record);
    this.audit?.record({
      category: "job",
      action: "cancel_job",
      status:
        result.status === "cancelled"
          ? "cancelled"
          : result.status === "failed"
            ? "failed"
            : "succeeded",
      workspace: result.workspace,
      subject: result.executable,
      summary: result.status,
      metadata: {
        job: result.id,
      },
    });

    return result;
  }

  async close(): Promise<void> {
    const running = [...this.#jobs.values()].filter(
      (record) => record.status === "running",
    );

    await Promise.allSettled(
      running.map((record) => this.cancel(record.id)),
    );

    await this.#persistence.waitPending();
  }

}


export {
  JobManagerError,
} from "./job-manager-types.js";
export type {
  JobManagerErrorCode,
  JobSnapshot,
  JobStatus,
} from "./job-manager-types.js";
