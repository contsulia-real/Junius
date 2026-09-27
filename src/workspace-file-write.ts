import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { WorkspaceFileError } from "./workspace-file-error.js";
import {
  pathInside,
  type WorkspacePathResolver,
} from "./workspace-path-resolver.js";
import { isProbablyBinary } from "./workspace-file-read.js";

export const MAX_WRITE_FILES = 16;
const MAX_WRITE_BYTES_PER_FILE = 2 * 1024 * 1024;
const MAX_WRITE_BYTES_TOTAL = 8 * 1024 * 1024;

export interface WriteEdit {
  readonly oldText: string;
  readonly newText: string;
  readonly replaceAll?: boolean;
}

export interface WriteRequest {
  readonly path: string;
  readonly content?: string;
  readonly edits?: readonly WriteEdit[];
}

export interface WriteResult {
  readonly path: string;
  readonly created: boolean;
  readonly bytes: number;
}

interface PreparedWrite {
  readonly targetPath: string;
  readonly relativePath: string;
  readonly created: boolean;
  readonly content: Buffer;
  readonly previous?: Buffer;
  readonly mode?: number;
}

async function validateWrite(
  resolver: WorkspacePathResolver,
  request: WriteRequest,
): Promise<PreparedWrite> {
  const hasContent = request.content !== undefined;
  const hasEdits = request.edits !== undefined;

  if (hasContent === hasEdits) {
    throw new WorkspaceFileError(
      "invalid_write",
      `write requires exactly one of content or edits: ${request.path}`,
    );
  }

  if (request.edits !== undefined && request.edits.length === 0) {
    throw new WorkspaceFileError(
      "invalid_write",
      `edits must not be empty: ${request.path}`,
    );
  }

  const target = await resolver.writable(request.path);

  if (!target.exists) {
    if (request.content === undefined) {
      throw new WorkspaceFileError(
        "invalid_write",
        `Creating a new file requires content: ${request.path}`,
      );
    }

    const content = Buffer.from(request.content, "utf8");
    if (content.length > MAX_WRITE_BYTES_PER_FILE) {
      throw new WorkspaceFileError(
        "write_too_large",
        `Write exceeds ${MAX_WRITE_BYTES_PER_FILE} bytes: ${request.path}`,
      );
    }

    return {
      targetPath: target.path,
      relativePath: target.relativePath,
      created: true,
      content,
    };
  }

  const info = await stat(target.path);
  if (!info.isFile()) {
    throw new WorkspaceFileError("not_a_file", request.path);
  }

  const previous = await readFile(target.path);
  if (isProbablyBinary(previous)) {
    throw new WorkspaceFileError("binary_file", request.path);
  }

  let nextText: string;

  if (request.content !== undefined) {
    nextText = request.content;
  } else {
    nextText = previous.toString("utf8");

    for (const edit of request.edits ?? []) {
      if (edit.oldText.length === 0) {
        throw new WorkspaceFileError(
          "invalid_write",
          `old_text must not be empty: ${request.path}`,
        );
      }

      let occurrences = 0;
      let offset = 0;
      for (;;) {
        const index = nextText.indexOf(edit.oldText, offset);
        if (index < 0) break;
        occurrences += 1;
        offset = index + edit.oldText.length;
      }

      if (occurrences === 0) {
        throw new WorkspaceFileError(
          "edit_not_found",
          `old_text was not found: ${request.path}`,
        );
      }

      if (edit.replaceAll === true) {
        nextText = nextText.split(edit.oldText).join(edit.newText);
        continue;
      }

      if (occurrences !== 1) {
        throw new WorkspaceFileError(
          "edit_not_unique",
          `old_text matched ${occurrences} times: ${request.path}`,
        );
      }

      nextText = nextText.replace(edit.oldText, edit.newText);
    }
  }

  const content = Buffer.from(nextText, "utf8");
  if (content.length > MAX_WRITE_BYTES_PER_FILE) {
    throw new WorkspaceFileError(
      "write_too_large",
      `Write exceeds ${MAX_WRITE_BYTES_PER_FILE} bytes: ${request.path}`,
    );
  }

  return {
    targetPath: target.path,
    relativePath: target.relativePath,
    created: false,
    content,
    previous,
    mode: info.mode,
  };
}

function writePathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function prepareWriteSet(
  resolver: WorkspacePathResolver,
  requests: readonly WriteRequest[],
): Promise<readonly PreparedWrite[]> {
  const prepared = await Promise.all(
    requests.map((request) => validateWrite(resolver, request)),
  );

  const targets = new Set<string>();
  let totalBytes = 0;

  for (const item of prepared) {
    totalBytes += item.content.length;
    if (totalBytes > MAX_WRITE_BYTES_TOTAL) {
      throw new WorkspaceFileError(
        "write_too_large",
        `write exceeds ${MAX_WRITE_BYTES_TOTAL} total bytes.`,
      );
    }

    const key = writePathKey(item.targetPath);
    if (targets.has(key)) {
      throw new WorkspaceFileError(
        "invalid_write",
        `Duplicate write target: ${item.relativePath}`,
      );
    }
    targets.add(key);
  }

  return prepared;
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
    canonicalParent = await realpath(parent);
  } catch (error) {
    throw new WorkspaceFileError(
      "write_failed",
      `Write parent changed after validation: ${item.relativePath}; ${errorMessage(error)}`,
    );
  }

  if (!pathInside(resolver.rootPath, canonicalParent)) {
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
