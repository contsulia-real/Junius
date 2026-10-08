import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  join,
} from "node:path";
import {
  resolveJuniusRuntimeRoot,
} from "./job-history-config.js";
import type {
  McpObservabilitySnapshot,
} from "./mcp-observability.js";

export interface PersistedSessionObservability {
  readonly version: 1;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly snapshot:
    McpObservabilitySnapshot;
}

export interface SessionObservabilityMetadata {
  readonly createdAt: string;
  readonly updatedAt: string;
}

const MAX_SESSIONS_ON_DISK = 256;
const SESSION_RETENTION_MS = 7 * 24 * 60 * 60_000;
const PRIVATE_INPUT = "[private input omitted]";

function privateSnapshot(snapshot: McpObservabilitySnapshot): McpObservabilitySnapshot {
  return {
    ...snapshot,
    turns: snapshot.turns.map((turn) => ({
      ...turn,
      title: PRIVATE_INPUT,
      tools: turn.tools.map((group) => ({
        ...group,
        calls: group.calls.map((call) => ({ ...call, input: PRIVATE_INPUT })),
      })),
      events: turn.events.map(({ input: _input, ...event }) => event),
    })),
  };
}

function fileName(
  sessionId: string,
): string {
  return (
    createHash("sha256")
      .update(sessionId)
      .digest("hex") +
    ".json"
  );
}

export function resolveMcpObservabilitySessionsPath(
  environment:
    NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  return join(
    resolveJuniusRuntimeRoot(
      environment,
      cwd,
    ),
    "observability",
    "sessions",
  );
}

export class McpObservabilityPersistence {
  constructor(
    readonly rootPath: string,
  ) {
    mkdirSync(
      rootPath,
      {
        recursive: true,
      },
    );
    this.#pruneAndScrub();
  }

  #pruneAndScrub(): void {
    const now = Date.now();
    const retained: { path: string; updatedAt: number }[] = [];
    for (const name of readdirSync(this.rootPath)) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const path = join(this.rootPath, name);
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedSessionObservability;
        const updatedAt = Date.parse(parsed.updatedAt);
        if (!Number.isFinite(updatedAt) || now - updatedAt > SESSION_RETENTION_MS) {
          rmSync(path, { force: true });
          continue;
        }
        const scrubbed = { ...parsed, snapshot: privateSnapshot(parsed.snapshot) };
        if (JSON.stringify(scrubbed.snapshot) !== JSON.stringify(parsed.snapshot)) this.#write(scrubbed);
        retained.push({ path, updatedAt });
      } catch {
        // Corrupt observation files cannot be trusted as privacy-safe history.
        rmSync(path, { force: true });
      }
    }
    retained.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const item of retained.slice(MAX_SESSIONS_ON_DISK)) rmSync(item.path, { force: true });
  }

  #path(
    sessionId: string,
  ): string {
    return join(
      this.rootPath,
      fileName(sessionId),
    );
  }

  read(
    sessionId: string,
  ):
    | PersistedSessionObservability
    | undefined {
    const path =
      this.#path(sessionId);

    if (!existsSync(path)) {
      return undefined;
    }

    try {
      const parsed =
        JSON.parse(
          readFileSync(
            path,
            "utf8",
          ),
        ) as
          Partial<
            PersistedSessionObservability
          >;

      if (
        parsed.version !== 1 ||
        parsed.sessionId !==
          sessionId ||
        typeof parsed.createdAt !==
          "string" ||
        typeof parsed.updatedAt !==
          "string" ||
        parsed.snapshot ===
          undefined
      ) {
        return undefined;
      }

      return parsed as
        PersistedSessionObservability;
    } catch {
      return undefined;
    }
  }

  ensure(
    sessionId: string,
    snapshot:
      McpObservabilitySnapshot,
  ): SessionObservabilityMetadata {
    const existing =
      this.read(sessionId);

    if (existing !== undefined) {
      return {
        createdAt:
          existing.createdAt,
        updatedAt:
          existing.updatedAt,
      };
    }

    const now =
      new Date().toISOString();

    this.#write({
      version: 1,
      sessionId,
      createdAt: now,
      updatedAt: now,
      snapshot,
    });
    this.#pruneAndScrub();

    return {
      createdAt: now,
      updatedAt: now,
    };
  }

  write(
    sessionId: string,
    snapshot:
      McpObservabilitySnapshot,
  ): SessionObservabilityMetadata {
    const existing =
      this.read(sessionId);
    const now =
      new Date().toISOString();
    const createdAt =
      existing?.createdAt ??
      now;

    this.#write({
      version: 1,
      sessionId,
      createdAt,
      updatedAt: now,
      snapshot,
    });

    return {
      createdAt,
      updatedAt: now,
    };
  }

  delete(
    sessionId: string,
  ): void {
    rmSync(
      this.#path(sessionId),
      {
        force: true,
      },
    );
  }

  #write(
    value:
      PersistedSessionObservability,
  ): void {
    const target =
      this.#path(
        value.sessionId,
      );
    const temporary =
      target +
      "." +
      randomUUID() +
      ".tmp";

    mkdirSync(
      dirname(target),
      {
        recursive: true,
      },
    );

    writeFileSync(
      temporary,
      JSON.stringify(
        { ...value, snapshot: privateSnapshot(value.snapshot) },
        null,
        2,
      ),
      "utf8",
    );
    renameSync(
      temporary,
      target,
    );
  }
}
