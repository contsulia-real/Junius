import {
  persistedSnapshot,
  snapshot,
  terminal,
  waitForCompletion,
  type JobRecord,
} from "./job-manager-runtime.js";
import type {
  JobSnapshot,
} from "./job-manager-types.js";
import type { JobPersistenceCoordinator } from "./job-persistence.js";

const DEFAULT_READ_CHARS = 64 * 1024;
const MAX_READ_CHARS = 256 * 1024;
export const DEFAULT_JOB_WAIT_MS = 5_000;
export const MAX_JOB_WAIT_MS = 10_000;

export interface JobOutputSlice {
  readonly job: JobSnapshot;
  readonly stream: "stdout" | "stderr";
  readonly offset: number;
  readonly nextOffset: number;
  readonly content: string;
  readonly eof: boolean;
  readonly truncated: boolean;
}

export class JobQueryService {
  constructor(
    private readonly jobs:
      Map<string, JobRecord>,
    private readonly persistence:
      JobPersistenceCoordinator,
  ) {}

  historyStats() {
    return this.persistence.stats();
  }

  async list(
    terminalLimit?: number,
  ): Promise<readonly JobSnapshot[]> {
    const live =
      [...this.jobs.values()].map(
        snapshot,
      );
    const running = live
      .filter(
        (job) =>
          job.status === "running",
      )
      .sort((left, right) =>
        right.startedAt.localeCompare(
          left.startedAt,
        ),
      );
    const liveTerminal = live
      .filter(
        (job) =>
          job.status !== "running",
      )
      .sort((left, right) =>
        right.startedAt.localeCompare(
          left.startedAt,
        ),
      );

    const boundedLimit =
      terminalLimit === undefined
        ? undefined
        : Math.max(
            0,
            Math.floor(
              terminalLimit,
            ),
          );

    const merged =
      new Map<string, JobSnapshot>();

    const historyRecords =
      await this.persistence.listMetadata(
        boundedLimit === undefined
          ? undefined
          : boundedLimit +
              liveTerminal.length,
      );

    for (
      const record of historyRecords
    ) {
      merged.set(
        record.id,
        persistedSnapshot(record),
      );
    }

    for (const job of liveTerminal) {
      merged.set(job.id, job);
    }

    const terminalJobs =
      [...merged.values()].sort(
        (left, right) =>
          right.startedAt.localeCompare(
            left.startedAt,
          ),
      );

    return [
      ...running,
      ...(boundedLimit === undefined
        ? terminalJobs
        : terminalJobs.slice(
            0,
            boundedLimit,
          )),
    ];
  }

  async get(
    id: string,
  ): Promise<JobSnapshot> {
    const record = this.jobs.get(id);
    if (record !== undefined) {
      return snapshot(record);
    }

    return persistedSnapshot(
      await this.persistence
        .loadMetadata(id),
    );
  }

  async wait(
    id: string,
    timeoutMs = DEFAULT_JOB_WAIT_MS,
  ): Promise<JobSnapshot> {
    const record = this.jobs.get(id);
    if (record === undefined) {
      return persistedSnapshot(
        await this.persistence
          .loadMetadata(id),
      );
    }

    if (terminal(record.status)) {
      return snapshot(record);
    }

    const boundedTimeout = Math.max(
      0,
      Math.min(
        timeoutMs,
        MAX_JOB_WAIT_MS,
      ),
    );

    await waitForCompletion(
      record,
      boundedTimeout,
    );

    return snapshot(record);
  }

  async readOutput(
    id: string,
    stream: "stdout" | "stderr",
    offset = 0,
    limit = DEFAULT_READ_CHARS,
  ): Promise<JobOutputSlice> {
    const live = this.jobs.get(id);

    let job: JobSnapshot;
    let text: string;
    let truncated: boolean;
    let isTerminal: boolean;

    if (live !== undefined) {
      job = snapshot(live);
      text =
        stream === "stdout"
          ? live.stdout
          : live.stderr;
      truncated =
        stream === "stdout"
          ? live.stdoutTruncated
          : live.stderrTruncated;
      isTerminal =
        terminal(live.status);
    } else {
      const persisted =
        await this.persistence
          .loadRecord(id);
      job =
        persistedSnapshot(
          persisted,
        );
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
      Math.min(
        offset,
        text.length,
      ),
    );
    const safeLimit = Math.max(
      1,
      Math.min(
        limit,
        MAX_READ_CHARS,
      ),
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
      content: text.slice(
        safeOffset,
        nextOffset,
      ),
      eof:
        isTerminal &&
        nextOffset >= text.length,
      truncated,
    };
  }
}
