import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { isProcessPreparableCapability } from "./capabilities/types.js";
import type { JobHistoryStore } from "./job-history-store.js";
import {
  appendCaptured,
  persistedSnapshot,
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
import { RunCommandService } from "./run-command.js";

const DEFAULT_READ_CHARS = 64 * 1024;
const MAX_READ_CHARS = 256 * 1024;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 60_000;

export class JobManager {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #persistence: JobPersistenceCoordinator;

  constructor(
    private readonly commands: RunCommandService,
    private readonly onTerminal?: (job: JobSnapshot) => void,
    history?: JobHistoryStore,
    onPersisted?: (job: JobSnapshot) => void,
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
  }

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
      this.#persistence.persist(record);

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
    return this.#persistence.stats();
  }

  async list(
    terminalLimit?: number,
  ): Promise<readonly JobSnapshot[]> {
    const live = [...this.#jobs.values()].map(
      snapshot,
    );
    const running = live
      .filter((job) => job.status === "running")
      .sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt),
      );
    const liveTerminal = live
      .filter((job) => job.status !== "running")
      .sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt),
      );

    const boundedLimit =
      terminalLimit === undefined
        ? undefined
        : Math.max(
            0,
            Math.floor(terminalLimit),
          );

    const merged = new Map<string, JobSnapshot>();

    const historyRecords =
      await this.#persistence.listMetadata(
        boundedLimit === undefined
          ? undefined
          : boundedLimit +
              liveTerminal.length,
      );

    for (const record of historyRecords) {
      merged.set(
        record.id,
        persistedSnapshot(record),
      );
    }

    for (const job of liveTerminal) {
      merged.set(job.id, job);
    }

    const terminal = [...merged.values()].sort(
      (left, right) =>
        right.startedAt.localeCompare(left.startedAt),
    );

    return [
      ...running,
      ...(boundedLimit === undefined
        ? terminal
        : terminal.slice(0, boundedLimit)),
    ];
  }

  async get(id: string): Promise<JobSnapshot> {
    const record = this.#jobs.get(id);
    if (record !== undefined) {
      return snapshot(record);
    }

    return persistedSnapshot(
      await this.#persistence.loadMetadata(id),
    );
  }

  async wait(
    id: string,
    timeoutMs = DEFAULT_WAIT_MS,
  ): Promise<JobSnapshot> {
    const record = this.#jobs.get(id);
    if (record === undefined) {
      return persistedSnapshot(
        await this.#persistence.loadMetadata(id),
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
      const persisted = await this.#persistence.loadRecord(id);
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
        await this.#persistence.loadMetadata(id),
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
