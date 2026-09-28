import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { environmentForSpawn } from "./execution-environment.js";
import type { AuditStore } from "./audit-store.js";
import { isProcessPreparableCapability } from "./capabilities/types.js";
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

  start(
    workspace: string,
    key: string,
    args: readonly string[],
  ): JobSnapshot {
    const authorized = this.commands.authorize(workspace, key, args);
    if (!authorized.ok) {
      this.audit?.record({
        category: "job",
        action: "start_job",
        status: "failed",
        workspace,
        subject: key,
        summary: authorized.code,
        metadata: {
          argCount: args.length,
          code: authorized.code,
        },
      });
      throw new JobManagerError(
        authorized.code,
        authorized.message,
      );
    }

    let auditArgs: readonly string[];
    try {
      auditArgs =
        authorized.capability
          .auditArguments?.(args) ??
        [...args];
    } catch {
      auditArgs = args.map(
        () => "[REDACTED]",
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
        prepared.execution.code === "arguments_not_allowed" ||
        prepared.execution.code === "unsafe_repository_config"
          ? prepared.execution.code
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
          env: environmentForSpawn(
            prepared.process.env,
          ),
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

    this.audit?.record({
      category: "job",
      action: "start_job",
      status: "started",
      workspace,
      subject: key,
      summary: "Background job started.",
      metadata: {
        job: record.id,
        pid: record.child.pid ?? -1,
        argCount: args.length,
        args: auditArgs,
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
        subject: key,
        summary: status,
        metadata: {
          job: record.id,
          argCount: args.length,
          args: auditArgs,
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
      subject: result.key,
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
