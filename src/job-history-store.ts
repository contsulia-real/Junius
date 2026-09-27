import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  parseJobHistoryMetadata,
  validJobHistoryId,
} from "./job-history-metadata.js";
import type {
  JobHistoryRetention,
  JobHistoryStats,
  PersistedJobMetadata,
  PersistedJobRecord,
} from "./job-history-types.js";

export {
  resolveJobHistoryPath,
  resolveJobHistoryRetention,
  resolveJuniusRuntimeRoot,
} from "./job-history-config.js";
export type {
  JobHistoryRetention,
  JobHistoryStats,
  PersistedJobMetadata,
  PersistedJobRecord,
  PersistedJobStatus,
} from "./job-history-types.js";

const DEFAULT_METADATA_CACHE_LIMIT = 256;

export class JobHistoryStore {
  readonly #metadataCache =
    new Map<string, PersistedJobMetadata>();

  constructor(
    readonly rootPath: string,
    readonly retention: JobHistoryRetention = {},
    readonly metadataCacheLimit = DEFAULT_METADATA_CACHE_LIMIT,
  ) {}

  #jobRoot(id: string): string {
    if (!validJobHistoryId(id)) {
      throw new Error("invalid_job_id");
    }
    return join(this.rootPath, id);
  }

  #metadataPath(id: string): string {
    return join(this.#jobRoot(id), "meta.json");
  }

  async save(
    record: PersistedJobRecord,
  ): Promise<void> {
    await mkdir(this.rootPath, {
      recursive: true,
    });

    const target = this.#jobRoot(record.id);
    const temporary = join(
      this.rootPath,
      "." + record.id + "." + randomUUID() + ".tmp",
    );

    const metadata: PersistedJobMetadata = {
      version: 1,
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
      stdoutChars: record.stdout.length,
      stderrChars: record.stderr.length,
      stdoutBytes: Buffer.byteLength(
        record.stdout,
        "utf8",
      ),
      stderrBytes: Buffer.byteLength(
        record.stderr,
        "utf8",
      ),
      stdoutTruncated: record.stdoutTruncated,
      stderrTruncated: record.stderrTruncated,
    };

    try {
      await mkdir(temporary, {
        recursive: true,
      });
      await Promise.all([
        writeFile(
          join(temporary, "meta.json"),
          JSON.stringify(metadata) + "\n",
          "utf8",
        ),
        writeFile(
          join(temporary, "stdout.txt"),
          record.stdout,
          "utf8",
        ),
        writeFile(
          join(temporary, "stderr.txt"),
          record.stderr,
          "utf8",
        ),
      ]);

      let created = false;
      try {
        await rename(temporary, target);
        this.#cacheMetadata(metadata);
        created = true;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (
            error.code === "EEXIST" ||
            error.code === "ENOTEMPTY"
          )
        ) {
          return;
        }
        throw error;
      }

      if (created) {
        await this.prune();
      }
    } finally {
      await rm(temporary, {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
  }

  #cacheMetadata(
    record: PersistedJobMetadata,
  ): void {
    const limit = Math.max(
      0,
      Math.floor(this.metadataCacheLimit),
    );

    if (limit === 0) {
      this.#metadataCache.clear();
      return;
    }

    this.#metadataCache.delete(record.id);
    this.#metadataCache.set(record.id, record);

    while (this.#metadataCache.size > limit) {
      const oldest =
        this.#metadataCache.keys().next().value;
      if (oldest === undefined) break;
      this.#metadataCache.delete(oldest);
    }
  }

  async #readMetadataFile(
    id: string,
  ): Promise<PersistedJobMetadata | undefined> {
    let text: string;

    try {
      text = await readFile(
        this.#metadataPath(id),
        "utf8",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }

    try {
      return parseJobHistoryMetadata(JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  async loadMetadata(
    id: string,
  ): Promise<PersistedJobMetadata | undefined> {
    const cached = this.#metadataCache.get(id);
    if (cached !== undefined) {
      try {
        await stat(this.#metadataPath(id));
        this.#cacheMetadata(cached);
        return cached;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          this.#metadataCache.delete(id);
          return undefined;
        }
        throw error;
      }
    }

    const record = await this.#readMetadataFile(id);
    if (record !== undefined) {
      this.#cacheMetadata(record);
    }
    return record;
  }

  async load(
    id: string,
  ): Promise<PersistedJobRecord | undefined> {
    const metadata = await this.loadMetadata(id);
    if (metadata === undefined) {
      return undefined;
    }

    let stdout: string;
    let stderr: string;

    try {
      [stdout, stderr] = await Promise.all([
        readFile(
          join(this.#jobRoot(id), "stdout.txt"),
          "utf8",
        ),
        readFile(
          join(this.#jobRoot(id), "stderr.txt"),
          "utf8",
        ),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }

    if (
      stdout.length !== metadata.stdoutChars ||
      stderr.length !== metadata.stderrChars
    ) {
      return undefined;
    }

    return {
      ...metadata,
      stdout,
      stderr,
    };
  }

  async listMetadata(
    limit?: number,
  ): Promise<readonly PersistedJobMetadata[]> {
    let entries;

    try {
      entries = await readdir(this.rootPath, {
        withFileTypes: true,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }

    const records = (
      await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.isDirectory() &&
              validJobHistoryId(entry.name),
          )
          .map((entry) =>
            this.#readMetadataFile(entry.name),
          ),
      )
    )
      .filter(
        (
          record,
        ): record is PersistedJobMetadata =>
          record !== undefined,
      )
      .sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt),
      );

    if (limit === undefined) {
      return records;
    }

    return records.slice(
      0,
      Math.max(0, Math.floor(limit)),
    );
  }

  async stats(): Promise<JobHistoryStats> {
    const records = await this.listMetadata();

    let capturedBytes = 0;

    await Promise.all(
      records.map(async (record) => {
        if (
          record.stdoutBytes !== undefined &&
          record.stderrBytes !== undefined
        ) {
          capturedBytes +=
            record.stdoutBytes +
            record.stderrBytes;
          return;
        }

        const root = this.#jobRoot(record.id);
        const sizes = await Promise.all(
          ["stdout.txt", "stderr.txt"].map(
            async (name) => {
              try {
                return (await stat(join(root, name))).size;
              } catch {
                return 0;
              }
            },
          ),
        );
        capturedBytes += sizes[0]! + sizes[1]!;
      }),
    );

    const endedAt = records
      .map((record) => record.endedAt)
      .sort();

    return {
      entries: records.length,
      capturedBytes,
      metadataCacheEntries:
        this.#metadataCache.size,
      metadataCacheLimit: Math.max(
        0,
        Math.floor(this.metadataCacheLimit),
      ),
      ...(endedAt[0] === undefined
        ? {}
        : { oldestEndedAt: endedAt[0] }),
      ...(endedAt.length === 0
        ? {}
        : {
            newestEndedAt:
              endedAt[endedAt.length - 1]!,
          }),
      retention: { ...this.retention },
    };
  }

  async prune(
    now = Date.now(),
  ): Promise<readonly string[]> {
    const { maxEntries, maxAgeMs } =
      this.retention;

    if (
      maxEntries === undefined &&
      maxAgeMs === undefined
    ) {
      return [];
    }

    const records = [
      ...(await this.listMetadata()),
    ].sort((left, right) =>
      right.endedAt.localeCompare(left.endedAt),
    );

    const remove = new Set<string>();

    if (maxAgeMs !== undefined) {
      const cutoff = now - maxAgeMs;
      for (const record of records) {
        const endedAt = Date.parse(record.endedAt);
        if (
          Number.isFinite(endedAt) &&
          endedAt < cutoff
        ) {
          remove.add(record.id);
        }
      }
    }

    if (maxEntries !== undefined) {
      const retained = records.filter(
        (record) => !remove.has(record.id),
      );
      for (const record of retained.slice(maxEntries)) {
        remove.add(record.id);
      }
    }

    await Promise.all(
      [...remove].map(async (id) => {
        await rm(this.#jobRoot(id), {
          recursive: true,
          force: true,
        });
        this.#metadataCache.delete(id);
      }),
    );

    return [...remove];
  }
}
