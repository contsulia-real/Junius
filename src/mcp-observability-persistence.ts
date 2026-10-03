import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
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
        value,
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
