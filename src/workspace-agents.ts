import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
} from "node:fs/promises";
import {
  dirname,
  join,
  relative,
} from "node:path";
import { WorkspaceFileError } from "./workspace-file-error.js";
import {
  pathInside,
  pathSegments,
  type WorkspacePathResolver,
} from "./workspace-path-resolver.js";

const AGENTS_FILENAME = "AGENTS.md";
const MAX_AGENTS_FILE_BYTES = 512 * 1024;
const MAX_AGENTS_TOTAL_BYTES = 2 * 1024 * 1024;

export interface WorkspaceAgentInstruction {
  readonly path: string;
  readonly scope: string;
  readonly depth: number;
  readonly content: string;
}

export interface WorkspaceAgentInstructions {
  readonly digest: string;
  readonly instructions: readonly WorkspaceAgentInstruction[];
}

function relativePath(
  root: string,
  path: string,
): string {
  const value = relative(
    root,
    path,
  ).replaceAll("\\", "/");
  return value === "" ? "." : value;
}

async function readAgentsFile(
  resolver: WorkspacePathResolver,
  path: string,
): Promise<WorkspaceAgentInstruction | undefined> {
  if (
    !pathInside(
      resolver.rootPath,
      path,
    ) ||
    resolver.isProtectedPath(path)
  ) {
    return undefined;
  }

  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (
        error.code === "ENOENT" ||
        error.code === "ENOTDIR"
      )
    ) {
      return undefined;
    }
    throw error;
  }

  if (
    !info.isFile() ||
    info.isSymbolicLink()
  ) {
    return undefined;
  }

  if (
    info.size >
    MAX_AGENTS_FILE_BYTES
  ) {
    throw new WorkspaceFileError(
      "agents_instructions_too_large",
      `AGENTS.md exceeds ${MAX_AGENTS_FILE_BYTES} bytes: ${relativePath(resolver.rootPath, path)}`,
    );
  }

  const content =
    await readFile(
      path,
      "utf8",
    );
  const directory =
    dirname(path);
  const scope =
    relativePath(
      resolver.rootPath,
      directory,
    );

  return {
    path:
      relativePath(
        resolver.rootPath,
        path,
      ),
    scope,
    depth:
      scope === "."
        ? 0
        : pathSegments(
            scope,
          ).length,
    content,
  };
}

function candidateDirectories(
  resolver: WorkspacePathResolver,
  inputPath: string,
): readonly string[] {
  const segments =
    inputPath
      .replaceAll("\\", "/")
      .split("/")
      .filter(
        (segment) =>
          segment !== "." &&
          segment.length > 0,
      );

  const directories = [
    resolver.rootPath,
  ];
  let current =
    resolver.rootPath;

  for (
    const segment of
    segments
  ) {
    current =
      join(
        current,
        segment,
      );
    directories.push(
      current,
    );
  }

  return directories;
}

async function applicableChain(
  resolver: WorkspacePathResolver,
  inputPath: string,
): Promise<readonly WorkspaceAgentInstruction[]> {
  const instructions:
    WorkspaceAgentInstruction[] = [];

  for (
    const directory of
    candidateDirectories(
      resolver,
      inputPath,
    )
  ) {
    const instruction =
      await readAgentsFile(
        resolver,
        join(
          directory,
          AGENTS_FILENAME,
        ),
      );
    if (
      instruction !==
      undefined
    ) {
      instructions.push(
        instruction,
      );
    }
  }

  return instructions;
}

async function descendantAgents(
  resolver: WorkspacePathResolver,
  inputPath: string,
  maxDepth?: number,
): Promise<readonly WorkspaceAgentInstruction[]> {
  let target;
  try {
    target =
      await resolver.existing(
        inputPath,
      );
  } catch (error) {
    if (
      error instanceof
        WorkspaceFileError &&
      error.code ===
        "path_not_found"
    ) {
      return [];
    }
    throw error;
  }

  const info =
    await lstat(
      target.path,
    );
  if (!info.isDirectory()) {
    return [];
  }

  const instructions:
    WorkspaceAgentInstruction[] = [];

  async function visit(
    directory: string,
    depth: number,
  ): Promise<void> {
    const instruction =
      await readAgentsFile(
        resolver,
        join(
          directory,
          AGENTS_FILENAME,
        ),
      );
    if (
      instruction !==
      undefined
    ) {
      instructions.push(
        instruction,
      );
    }

    if (
      maxDepth !==
        undefined &&
      depth >= maxDepth
    ) {
      return;
    }

    const entries =
      await readdir(
        directory,
        {
          withFileTypes: true,
        },
      );

    for (
      const entry of entries
    ) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.name.toLowerCase() ===
          ".git" ||
        entry.name.toLowerCase() ===
          ".junius"
      ) {
        continue;
      }

      const child =
        join(
          directory,
          entry.name,
        );
      if (
        resolver.isProtectedPath(
          child,
        ) ||
        !pathInside(
          resolver.rootPath,
          child,
        )
      ) {
        continue;
      }

      await visit(
        child,
        depth + 1,
      );
    }
  }

  await visit(
    target.path,
    0,
  );
  return instructions;
}

function finalize(
  instructions:
    readonly WorkspaceAgentInstruction[],
): WorkspaceAgentInstructions {
  const unique =
    new Map<
      string,
      WorkspaceAgentInstruction
    >();

  for (
    const instruction of
    instructions
  ) {
    unique.set(
      instruction.path,
      instruction,
    );
  }

  const ordered =
    [...unique.values()]
      .sort(
        (left, right) =>
          left.depth -
            right.depth ||
          left.path.localeCompare(
            right.path,
          ),
      );

  const totalBytes =
    ordered.reduce(
      (total, instruction) =>
        total +
        Buffer.byteLength(
          instruction.content,
          "utf8",
        ),
      0,
    );

  if (
    totalBytes >
    MAX_AGENTS_TOTAL_BYTES
  ) {
    throw new WorkspaceFileError(
      "agents_instructions_too_large",
      `Applicable AGENTS.md instructions exceed ${MAX_AGENTS_TOTAL_BYTES} bytes total.`,
    );
  }

  const digest =
    createHash("sha256")
      .update(
        JSON.stringify(
          ordered.map(
            (instruction) => ({
              path:
                instruction.path,
              scope:
                instruction.scope,
              content:
                instruction.content,
            }),
          ),
        ),
      )
      .digest("hex");

  return {
    digest,
    instructions:
      ordered,
  };
}

export async function agentsForPaths(
  resolver: WorkspacePathResolver,
  paths: readonly string[],
): Promise<WorkspaceAgentInstructions> {
  const chains =
    await Promise.all(
      paths.map(
        (path) =>
          applicableChain(
            resolver,
            path,
          ),
      ),
    );

  return finalize(
    chains.flat(),
  );
}

export async function agentsForScan(
  resolver: WorkspacePathResolver,
  path: string,
  maxDepth?: number,
): Promise<WorkspaceAgentInstructions> {
  const [
    chain,
    descendants,
  ] =
    await Promise.all([
      applicableChain(
        resolver,
        path,
      ),
      descendantAgents(
        resolver,
        path,
        maxDepth,
      ),
    ]);

  return finalize([
    ...chain,
    ...descendants,
  ]);
}

export function assertAgentsDigest(
  expected:
    WorkspaceAgentInstructions,
  supplied:
    string | undefined,
): void {
  if (
    expected.instructions
      .length === 0
  ) {
    return;
  }

  if (
    supplied ===
    expected.digest
  ) {
    return;
  }

  throw new WorkspaceFileError(
    "agents_ack_required",
    "Applicable AGENTS.md instructions must be reviewed before this Workspace mutation. Retry with the returned agents_digest after following those instructions.",
    {
      agentsDigest:
        expected.digest,
      agentInstructions:
        expected.instructions,
    },
  );
}
