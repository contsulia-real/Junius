import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { WorkspaceFileError } from "./workspace-file-error.js";
import {
  pathInside,
  type WorkspacePathResolver,
} from "./workspace-path-resolver.js";
import {
  prepareWriteSet,
  type PreparedWrite,
  type WriteRequest,
  type WriteResult,
} from "./workspace-file-write-plan.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function missingParentDirectories(
  resolver: WorkspacePathResolver,
  targetPath: string,
): Promise<readonly string[]> {
  const missing: string[] = [];
  let current = dirname(targetPath);

  while (current !== resolver.rootPath && pathInside(resolver.rootPath, current)) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory()) {
        throw new WorkspaceFileError(
          "invalid_path",
          `Write parent is not a directory: ${current}`,
        );
      }
      break;
    } catch (error) {
      if (
        error instanceof WorkspaceFileError ||
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }

      missing.push(current);
      current = dirname(current);
    }
  }

  return missing;
}

interface StagedWrite {
  readonly prepared: PreparedWrite;
  readonly tempPath: string;
  backupPath?: string;
  installed: boolean;
}

async function assertWriteParentSafe(
  resolver: WorkspacePathResolver,
  item: PreparedWrite,
): Promise<void> {
  const parent = dirname(item.targetPath);
  let canonicalParent: string;

  try {
    canonicalParent = realpathSync(parent);
  } catch (error) {
    throw new WorkspaceFileError(
      "write_failed",
      `Write parent changed after validation: ${item.relativePath}; ${errorMessage(error)}`,
    );
  }

  if (
    !pathInside(
      resolver.canonicalRootPath,
      canonicalParent,
    )
  ) {
    throw new WorkspaceFileError(
      "path_outside_workspace",
      item.relativePath,
    );
  }

  let current = parent;
  while (
    current !== resolver.rootPath &&
    pathInside(resolver.rootPath, current)
  ) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new WorkspaceFileError(
        "invalid_path",
        `Writing through a symbolic/reparse parent is not allowed: ${item.relativePath}`,
      );
    }
    current = dirname(current);
  }
}

async function assertTargetUnchanged(item: PreparedWrite): Promise<void> {
  if (item.created) {
    try {
      await lstat(item.targetPath);
      throw new WorkspaceFileError(
        "write_failed",
        `Write target appeared after validation: ${item.relativePath}`,
      );
    } catch (error) {
      if (
        error instanceof WorkspaceFileError ||
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }
    }
    return;
  }

  const info = await lstat(item.targetPath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new WorkspaceFileError(
      "write_failed",
      `Write target changed type after validation: ${item.relativePath}`,
    );
  }

  const current = await readFile(item.targetPath);
  if (item.previous === undefined || !current.equals(item.previous)) {
    throw new WorkspaceFileError(
      "write_failed",
      `Write target changed after validation: ${item.relativePath}`,
    );
  }
}

async function cleanupDirectories(
  directories: readonly string[],
): Promise<void> {
  const unique = [...new Set(directories)].sort(
    (left, right) => right.length - left.length,
  );

  for (const directory of unique) {
    try {
      await rmdir(directory);
    } catch {
      // Keep non-empty or concurrently created directories.
    }
  }
}

export async function transactionalWrite(
  resolver: WorkspacePathResolver,
  requests: readonly WriteRequest[],
): Promise<readonly WriteResult[]> {
  const prepared = await prepareWriteSet(resolver, requests);
  const createdDirectories: string[] = [];
  const staged: StagedWrite[] = [];

  try {
    const missingLists = await Promise.all(
      prepared.map((item) =>
        missingParentDirectories(resolver, item.targetPath),
      ),
    );

    for (const directory of missingLists.flat()) {
      if (!createdDirectories.includes(directory)) {
        createdDirectories.push(directory);
      }
    }

    await Promise.all(
      prepared.map((item) => mkdir(dirname(item.targetPath), { recursive: true })),
    );

    await Promise.all(
      prepared.map((item) =>
        assertWriteParentSafe(resolver, item),
      ),
    );

    await Promise.all(
      prepared.map(async (item) => {
        const tempPath = join(
          dirname(item.targetPath),
          `.junius-${randomUUID()}.tmp`,
        );
        const stage: StagedWrite = {
          prepared: item,
          tempPath,
          installed: false,
        };
        staged.push(stage);

        await writeFile(tempPath, item.content, { flag: "wx" });
        if (item.mode !== undefined) {
          await chmod(tempPath, item.mode);
        }
      }),
    );

    for (const stage of staged) {
      const item = stage.prepared;
      await assertWriteParentSafe(resolver, item);
      await assertTargetUnchanged(item);

      if (!item.created) {
        const backupPath = join(
          dirname(item.targetPath),
          `.junius-${randomUUID()}.bak`,
        );
        await rename(item.targetPath, backupPath);
        stage.backupPath = backupPath;
      }

      await rename(stage.tempPath, item.targetPath);
      stage.installed = true;
    }
  } catch (error) {
    const rollbackErrors: string[] = [];

    for (const stage of [...staged].reverse()) {
      const item = stage.prepared;

      if (stage.installed) {
        try {
          await rm(item.targetPath, { force: true });
        } catch (rollbackError) {
          rollbackErrors.push(errorMessage(rollbackError));
        }
      }

      if (stage.backupPath !== undefined) {
        try {
          await rename(stage.backupPath, item.targetPath);
          stage.backupPath = undefined;
        } catch (rollbackError) {
          rollbackErrors.push(errorMessage(rollbackError));
        }
      }

      try {
        await rm(stage.tempPath, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(errorMessage(rollbackError));
      }
    }

    await cleanupDirectories(createdDirectories);

    if (error instanceof WorkspaceFileError && rollbackErrors.length === 0) {
      throw error;
    }

    throw new WorkspaceFileError(
      "write_failed",
      `Transactional write failed: ${errorMessage(error)}${
        rollbackErrors.length === 0
          ? ""
          : `; rollback errors: ${rollbackErrors.join(" | ")}`
      }`,
    );
  }

  await Promise.allSettled(
    staged.flatMap((stage) =>
      stage.backupPath === undefined ? [] : [rm(stage.backupPath, { force: true })],
    ),
  );

  return prepared.map((item) => ({
    path: item.relativePath,
    created: item.created,
    bytes: item.content.length,
  }));
}

