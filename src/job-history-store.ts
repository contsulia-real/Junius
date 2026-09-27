import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

export type PersistedJobStatus =
  | "succeeded"
  | "failed"
  | "cancelled";

export interface PersistedJobMetadata {
  readonly version: 1;
  readonly id: string;
  readonly workspace: string;
  readonly key: string;
  readonly status: PersistedJobStatus;
  readonly pid: number | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly message?: string;
  readonly stdoutChars: number;
  readonly stderrChars: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface PersistedJobRecord
  extends PersistedJobMetadata {
  readonly stdout: string;
  readonly stderr: string;
}

function validId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    id,
  );
}

export function resolveJobHistoryPath(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const projectRoot =
    environment.JUNIUS_PROJECT_ROOT ?? cwd;
  const runtimeRoot = resolve(
    environment.JUNIUS_RUNTIME_ROOT ??
      join(projectRoot, ".junius", "runtime"),
  );

  return join(runtimeRoot, "jobs");
}

function parseMetadata(
  value: unknown,
): PersistedJobMetadata | undefined {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return undefined;
  }

  const record = value as Partial<PersistedJobMetadata>;

  if (
    record.version !== 1 ||
    typeof record.id !== "string" ||
    !validId(record.id) ||
    typeof record.workspace !== "string" ||
    typeof record.key !== "string" ||
    !["succeeded", "failed", "cancelled"].includes(
      String(record.status),
    ) ||
    !(
      record.pid === null ||
      typeof record.pid === "number"
    ) ||
    typeof record.startedAt !== "string" ||
    typeof record.endedAt !== "string" ||
    typeof record.stdoutChars !== "number" ||
    !Number.isSafeInteger(record.stdoutChars) ||
    record.stdoutChars < 0 ||
    typeof record.stderrChars !== "number" ||
    !Number.isSafeInteger(record.stderrChars) ||
    record.stderrChars < 0 ||
    typeof record.stdoutTruncated !== "boolean" ||
    typeof record.stderrTruncated !== "boolean"
  ) {
    return undefined;
  }

  if (
    record.exitCode !== undefined &&
    record.exitCode !== null &&
    typeof record.exitCode !== "number"
  ) {
    return undefined;
  }

  if (
    record.signal !== undefined &&
    record.signal !== null &&
    typeof record.signal !== "string"
  ) {
    return undefined;
  }

  if (
    record.message !== undefined &&
    typeof record.message !== "string"
  ) {
    return undefined;
  }

  return record as PersistedJobMetadata;
}

export class JobHistoryStore {
  constructor(
    readonly rootPath: string,
  ) {}

  #jobRoot(id: string): string {
    if (!validId(id)) {
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

      try {
        await rename(temporary, target);
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
    } finally {
      await rm(temporary, {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
  }

  async loadMetadata(
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
      return parseMetadata(JSON.parse(text));
    } catch {
      return undefined;
    }
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

  async listMetadata(): Promise<
    readonly PersistedJobMetadata[]
  > {
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

    const records = await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            validId(entry.name),
        )
        .map((entry) =>
          this.loadMetadata(entry.name),
        ),
    );

    return records.filter(
      (
        record,
      ): record is PersistedJobMetadata =>
        record !== undefined,
    );
  }
}
