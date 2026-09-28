import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { resolveJuniusRuntimeRoot } from "./job-history-config.js";

export type AuditCategory =
  | "command"
  | "job"
  | "workspace"
  | "browser"
  | "desktop"
  | "configuration";

export type AuditStatus =
  | "started"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AuditMetadataValue =
  | string
  | number
  | boolean
  | readonly string[];

export interface AuditEvent {
  readonly version: 1;
  readonly id: string;
  readonly timestamp: string;
  readonly category: AuditCategory;
  readonly action: string;
  readonly status: AuditStatus;
  readonly workspace?: string;
  readonly subject?: string;
  readonly summary?: string;
  readonly durationMs?: number;
  readonly metadata?: Readonly<
    Record<string, AuditMetadataValue>
  >;
}

export interface AuditEventInput {
  readonly category: AuditCategory;
  readonly action: string;
  readonly status: AuditStatus;
  readonly workspace?: string;
  readonly subject?: string;
  readonly summary?: string;
  readonly durationMs?: number;
  readonly metadata?: Readonly<
    Record<string, AuditMetadataValue>
  >;
}

export interface AuditRetention {
  readonly maxEntries: number;
  readonly maxAgeMs: number;
}

const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_AGE_MS =
  7 * 24 * 60 * 60 * 1_000;
const MAX_LIST_LIMIT = 1_000;
const RECENT_MEMORY_LIMIT = 256;

function positiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) &&
    parsed > 0
    ? parsed
    : fallback;
}

export function resolveAuditPath(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  return (
    environment.JUNIUS_AUDIT_PATH ??
    join(
      resolveJuniusRuntimeRoot(
        environment,
        cwd,
      ),
      "audit",
    )
  );
}

export function resolveAuditRetention(
  environment: NodeJS.ProcessEnv = process.env,
): AuditRetention {
  return {
    maxEntries: positiveInteger(
      environment.JUNIUS_AUDIT_MAX_ENTRIES,
      DEFAULT_MAX_ENTRIES,
    ),
    maxAgeMs: positiveInteger(
      environment.JUNIUS_AUDIT_MAX_AGE_MS,
      DEFAULT_MAX_AGE_MS,
    ),
  };
}

function boundedString(
  value: string | undefined,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= max
    ? value
    : value.slice(0, max);
}

function sanitizeMetadata(
  metadata:
    | Readonly<Record<string, AuditMetadataValue>>
    | undefined,
): Readonly<Record<string, AuditMetadataValue>> | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  const entries = Object.entries(metadata)
    .slice(0, 32)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return [
          key.slice(0, 128),
          value
            .slice(0, 64)
            .map((item) =>
              String(item).slice(0, 4_096),
            ),
        ] as const;
      }
      if (typeof value === "string") {
        return [
          key.slice(0, 128),
          value.slice(0, 4_096),
        ] as const;
      }
      return [
        key.slice(0, 128),
        value,
      ] as const;
    });

  return Object.fromEntries(entries);
}

function auditFileName(
  event: AuditEvent,
): string {
  const millis = Date.parse(
    event.timestamp,
  );
  return (
    String(
      Number.isFinite(millis)
        ? millis
        : Date.now(),
    ).padStart(13, "0") +
    "-" +
    event.id +
    ".json"
  );
}

function parseAuditEvent(
  value: unknown,
): AuditEvent | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("timestamp" in value) ||
    typeof value.timestamp !== "string" ||
    !("category" in value) ||
    typeof value.category !== "string" ||
    !("action" in value) ||
    typeof value.action !== "string" ||
    !("status" in value) ||
    typeof value.status !== "string"
  ) {
    return undefined;
  }

  return value as AuditEvent;
}

function isNotFound(
  error: unknown,
): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export class AuditStore {
  readonly #recent =
    new Map<string, AuditEvent>();
  readonly #pending =
    new Set<Promise<void>>();
  #lastTimestampMs = 0;

  constructor(
    readonly rootPath: string,
    readonly retention: AuditRetention =
      resolveAuditRetention(),
  ) {}

  record(
    input: AuditEventInput,
  ): AuditEvent {
    const timestampMs = Math.max(
      Date.now(),
      this.#lastTimestampMs + 1,
    );
    this.#lastTimestampMs =
      timestampMs;

    const event: AuditEvent = {
      version: 1,
      id: randomUUID(),
      timestamp:
        new Date(
          timestampMs,
        ).toISOString(),
      category: input.category,
      action:
        boundedString(
          input.action,
          128,
        ) ?? "unknown",
      status: input.status,
      ...(input.workspace === undefined
        ? {}
        : {
            workspace: boundedString(
              input.workspace,
              128,
            ),
          }),
      ...(input.subject === undefined
        ? {}
        : {
            subject: boundedString(
              input.subject,
              256,
            ),
          }),
      ...(input.summary === undefined
        ? {}
        : {
            summary: boundedString(
              input.summary,
              2_048,
            ),
          }),
      ...(input.durationMs === undefined
        ? {}
        : {
            durationMs: Math.max(
              0,
              Math.round(
                input.durationMs,
              ),
            ),
          }),
      ...(input.metadata === undefined
        ? {}
        : {
            metadata:
              sanitizeMetadata(
                input.metadata,
              ),
          }),
    };

    this.#remember(event);

    const operation =
      this.#persist(event)
        .catch((error) => {
          console.warn(
            "[audit]",
            error instanceof Error
              ? error.message
              : String(error),
          );
        });
    this.#pending.add(operation);
    void operation.finally(() => {
      this.#pending.delete(operation);
    });

    return event;
  }

  async list(
    limit = 200,
  ): Promise<readonly AuditEvent[]> {
    const boundedLimit = Math.max(
      1,
      Math.min(
        MAX_LIST_LIMIT,
        Math.floor(limit),
      ),
    );

    let entries: Dirent[];
    try {
      entries = await readdir(
        this.rootPath,
        {
          withFileTypes: true,
        },
      );
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      entries = [];
    }

    const files = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".json"),
      )
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(
        0,
        Math.max(
          boundedLimit,
          RECENT_MEMORY_LIMIT,
        ),
      );

    const persisted = (
      await Promise.all(
        files.map(async (name) => {
          try {
            const text = await readFile(
              join(
                this.rootPath,
                name,
              ),
              "utf8",
            );
            return parseAuditEvent(
              JSON.parse(text) as unknown,
            );
          } catch (error) {
            if (isNotFound(error)) {
              return undefined;
            }
            return undefined;
          }
        }),
      )
    ).filter(
      (
        event,
      ): event is AuditEvent =>
        event !== undefined,
    );

    const merged =
      new Map<string, AuditEvent>();
    for (const event of persisted) {
      merged.set(event.id, event);
    }
    for (const event of this.#recent.values()) {
      merged.set(event.id, event);
    }

    const cutoff =
      Date.now() -
      this.retention.maxAgeMs;

    return [...merged.values()]
      .filter(
        (event) => {
          const millis =
            Date.parse(
              event.timestamp,
            );
          return (
            !Number.isFinite(
              millis,
            ) ||
            millis >= cutoff
          );
        },
      )
      .sort((left, right) =>
        right.timestamp.localeCompare(
          left.timestamp,
        ),
      )
      .slice(
        0,
        Math.min(
          boundedLimit,
          this.retention.maxEntries,
        ),
      );
  }

  async stats(): Promise<{
    readonly entries: number;
    readonly retention: AuditRetention;
  }> {
    const events = await this.list(
      this.retention.maxEntries,
    );
    return {
      entries: events.length,
      retention: this.retention,
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.#pending],
    );
  }

  #remember(
    event: AuditEvent,
  ): void {
    this.#recent.delete(event.id);
    this.#recent.set(
      event.id,
      event,
    );
    while (
      this.#recent.size >
      RECENT_MEMORY_LIMIT
    ) {
      const oldest =
        this.#recent.keys()
          .next().value;
      if (oldest === undefined) {
        break;
      }
      this.#recent.delete(oldest);
    }
  }

  async #persist(
    event: AuditEvent,
  ): Promise<void> {
    await mkdir(
      this.rootPath,
      { recursive: true },
    );
    const target = join(
      this.rootPath,
      auditFileName(event),
    );
    const temporary =
      target +
      "." +
      process.pid +
      ".tmp";

    try {
      await writeFile(
        temporary,
        JSON.stringify(event) + "\n",
        "utf8",
      );
      await rename(
        temporary,
        target,
      );
      await this.#prune();
    } finally {
      await rm(
        temporary,
        { force: true },
      ).catch(() => {});
    }
  }

  async #prune():
    Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(
        this.rootPath,
        {
          withFileTypes: true,
        },
      );
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }

    const files = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".json"),
      )
      .map((entry) => entry.name)
      .sort()
      .reverse();

    const cutoff =
      Date.now() -
      this.retention.maxAgeMs;

    await Promise.allSettled(
      files.map(
        async (name, index) => {
          const millis = Number(
            name.slice(0, 13),
          );
          if (
            index >=
              this.retention.maxEntries ||
            (Number.isFinite(millis) &&
              millis < cutoff)
          ) {
            await rm(
              join(
                this.rootPath,
                name,
              ),
              { force: true },
            );
          }
        },
      ),
    );
  }
}
