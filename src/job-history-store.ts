import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  RunningJobMarker,
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
  RunningJobMarker,
} from "./job-history-types.js";

const DEFAULT_METADATA_CACHE_LIMIT = 256;

function parseRunningJobMarker(
  value: unknown,
): RunningJobMarker | undefined {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return undefined;
  }

  const marker =
    value as Partial<RunningJobMarker>;

  if (
    marker.version !== 1 ||
    typeof marker.id !== "string" ||
    !validJobHistoryId(marker.id) ||
    typeof marker.ownerWorkerId !== "string" ||
    marker.ownerWorkerId.length === 0 ||
    typeof marker.workspace !== "string" ||
    typeof marker.key !== "string" ||
    typeof marker.startedAt !== "string"
  ) {
    return undefined;
  }

  return marker as RunningJobMarker;
}

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

  #runningRoot(): string {
    return join(this.rootPath, ".running");
  }

  #runningPath(id: string): string {
    if (!validJobHistoryId(id)) {
      throw new Error("invalid_job_id");
    }

    return join(
      this.#runningRoot(),
      id + ".json",
    );
  }

  async saveRunning(
    marker: RunningJobMarker,
  ): Promise<void> {
    await mkdir(this.#runningRoot(), {
      recursive: true,
    });

    const target = this.#runningPath(marker.id);
    const temporary =
      target + "." + randomUUID() + ".tmp";

    try {
      await writeFile(
        temporary,
        JSON.stringify(marker) + "\n",
        "utf8",
      );
      await rm(target, { force: true });
      await rename(temporary, target);
    } finally {
      await rm(temporary, {
        force: true,
      }).catch(() => {});
    }
  }

  async clearRunning(id: string): Promise<void> {
    await rm(this.#runningPath(id), {
      force: true,
    });
  }

  recoverInterruptedSync(
    ownerWorkerId: string,
    endedAt = new Date().toISOString(),
  ): readonly PersistedJobMetadata[] {
    let entries;
    try {
      entries = readdirSync(
        this.#runningRoot(),
        { withFileTypes: true },
      );
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

    const recovered: PersistedJobMetadata[] = [];

    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".json")
      ) {
        continue;
      }

      const markerPath = join(
        this.#runningRoot(),
        entry.name,
      );

      let marker: RunningJobMarker | undefined;
      try {
        marker = parseRunningJobMarker(
          JSON.parse(
            readFileSync(markerPath, "utf8"),
          ),
        );
      } catch {
        marker = undefined;
      }

      if (
        marker === undefined ||
        marker.ownerWorkerId !== ownerWorkerId
      ) {
        continue;
      }

      const target = this.#jobRoot(marker.id);
      if (!existsSync(target)) {
        mkdirSync(this.rootPath, {
          recursive: true,
        });
        const temporary = join(
          this.rootPath,
          "." + marker.id + "." + randomUUID() + ".tmp",
        );
        const metadata: PersistedJobMetadata = {
          version: 1,
          id: marker.id,
          workspace: marker.workspace,
          key: marker.key,
          status: "interrupted",
          pid: null,
          startedAt: marker.startedAt,
          endedAt,
          message: "worker_or_host_lost",
          stdoutChars: 0,
          stderrChars: 0,
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
        };

        try {
          mkdirSync(temporary, {
            recursive: true,
          });
          writeFileSync(
            join(temporary, "meta.json"),
            JSON.stringify(metadata) + "\n",
            "utf8",
          );
          writeFileSync(
            join(temporary, "stdout.txt"),
            "",
            "utf8",
          );
          writeFileSync(
            join(temporary, "stderr.txt"),
            "",
            "utf8",
          );
          try {
            renameSync(temporary, target);
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                (
                  error.code === "EEXIST" ||
                  error.code === "ENOTEMPTY"
                )
              )
            ) {
              throw error;
            }
          }
        } finally {
          rmSync(temporary, {
            recursive: true,
            force: true,
          });
        }
      }

      rmSync(markerPath, {
        force: true,
      });

      try {
        const metadata = parseJobHistoryMetadata(
          JSON.parse(
            readFileSync(
              this.#metadataPath(marker.id),
              "utf8",
            ),
          ),
        );
        if (metadata !== undefined) {
          this.#cacheMetadata(metadata);
          recovered.push(metadata);
        }
      } catch {
        // Terminal history may have been completed concurrently.
      }
    }

    return recovered;
  }

  async recoverInterrupted(
    ownerWorkerId?: string,
    endedAt = new Date().toISOString(),
  ): Promise<readonly PersistedJobMetadata[]> {
    let entries;
    try {
      entries = await readdir(
        this.#runningRoot(),
        { withFileTypes: true },
      );
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

    const recovered: PersistedJobMetadata[] = [];

    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".json")
      ) {
        continue;
      }

      const path = join(
        this.#runningRoot(),
        entry.name,
      );

      let marker: RunningJobMarker | undefined;
      try {
        marker = parseRunningJobMarker(
          JSON.parse(
            await readFile(path, "utf8"),
          ),
        );
      } catch {
        marker = undefined;
      }

      if (
        marker === undefined ||
        (
          ownerWorkerId !== undefined &&
          marker.ownerWorkerId !== ownerWorkerId
        )
      ) {
        continue;
      }

      await this.save({
        version: 1,
        id: marker.id,
        workspace: marker.workspace,
        key: marker.key,
        status: "interrupted",
        pid: null,
        startedAt: marker.startedAt,
        endedAt,
        message: "worker_or_host_lost",
        stdoutChars: 0,
        stderrChars: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });

      await this.clearRunning(marker.id);

      const metadata =
        await this.loadMetadata(marker.id);
      if (metadata !== undefined) {
        recovered.push(metadata);
      }
    }

    return recovered;
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
