import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WorkspaceFileError } from "./workspace-file-error.js";
import { isProbablyBinary } from "./workspace-file-read.js";
import { transactionalWrite } from "./workspace-file-transaction.js";
import { applyLinePatch, type WritePatchHunk } from "./workspace-line-patch.js";
import { pathInside, type WorkspacePathResolver } from "./workspace-path-resolver.js";

export const MAX_WORKSPACE_MUTATION_BYTES = 16 * 1024 * 1024;

export type WorkspaceMutation =
  | { readonly kind: "write"; readonly path: string; readonly content: string }
  | { readonly kind: "patch"; readonly path: string; readonly hunks: readonly WritePatchHunk[] }
  | { readonly kind: "delete"; readonly path: string; readonly expectedHunks?: readonly WritePatchHunk[] }
  | { readonly kind: "move"; readonly source: string; readonly destination: string; readonly overwrite?: boolean }
  | { readonly kind: "copy"; readonly source: string; readonly destination: string; readonly overwrite?: boolean }
  | { readonly kind: "mkdir"; readonly path: string };

export type WorkspaceMutationResult =
  | { readonly kind: "write" | "patch"; readonly path: string; readonly created: boolean; readonly bytes: number }
  | { readonly kind: "delete"; readonly path: string; readonly bytes: number }
  | { readonly kind: "move" | "copy"; readonly source: string; readonly destination: string; readonly overwritten: boolean; readonly bytes: number }
  | { readonly kind: "mkdir"; readonly path: string; readonly created: boolean };

interface AppliedMutation {
  readonly result: WorkspaceMutationResult;
  rollback(): Promise<void>;
  commit(): Promise<void>;
}

interface FileSnapshot {
  readonly path: string;
  readonly relativePath: string;
  readonly content: Buffer;
  readonly mode: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
}

async function missingDirectories(
  resolver: WorkspacePathResolver,
  targetDirectory: string,
): Promise<readonly string[]> {
  const missing: string[] = [];
  let current = targetDirectory;
  while (current !== resolver.rootPath && pathInside(resolver.rootPath, current)) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory()) {
        throw new WorkspaceFileError("invalid_path", "Mutation parent is not a directory: " + current);
      }
      break;
    } catch (error) {
      if (error instanceof WorkspaceFileError || !isMissingError(error)) throw error;
      missing.push(current);
      current = dirname(current);
    }
  }
  return missing;
}

async function cleanupDirectories(directories: readonly string[]): Promise<void> {
  const unique = [...new Set(directories)].sort((left, right) => right.length - left.length);
  for (const directory of unique) {
    try {
      await rmdir(directory);
    } catch {
      // Keep non-empty or concurrently created directories.
    }
  }
}

async function assertParentSafe(
  resolver: WorkspacePathResolver,
  targetPath: string,
  displayPath: string,
): Promise<void> {
  const parent = dirname(targetPath);
  let canonicalParent: string;
  try {
    canonicalParent = realpathSync(parent);
  } catch (error) {
    throw new WorkspaceFileError(
      "write_failed",
      "Mutation parent changed after validation: " + displayPath + "; " + errorMessage(error),
    );
  }
  if (!pathInside(resolver.canonicalRootPath, canonicalParent)) {
    throw new WorkspaceFileError("path_outside_workspace", displayPath);
  }
  resolver.assertNotProtected(canonicalParent);
  let current = parent;
  while (current !== resolver.rootPath && pathInside(resolver.rootPath, current)) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new WorkspaceFileError(
        "invalid_path",
        "Mutating through a symbolic/reparse parent is not allowed: " + displayPath,
      );
    }
    current = dirname(current);
  }
}

async function snapshotFile(
  resolver: WorkspacePathResolver,
  path: string,
): Promise<FileSnapshot | undefined> {
  const target = await resolver.writable(path);
  if (!target.exists) return undefined;
  const info = await lstat(target.path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new WorkspaceFileError("not_a_file", path);
  }
  return {
    path: target.path,
    relativePath: target.relativePath,
    content: await readFile(target.path),
    mode: info.mode,
  };
}

async function assertFileEquals(path: string, expected: Buffer, displayPath: string): Promise<void> {
  let current: Buffer;
  try {
    current = await readFile(path);
  } catch (error) {
    throw new WorkspaceFileError(
      "write_failed",
      "Mutation target changed while applying " + displayPath + ": " + errorMessage(error),
    );
  }
  if (!current.equals(expected)) {
    throw new WorkspaceFileError("write_failed", "Mutation target changed while applying " + displayPath + ".");
  }
}

async function applyTextMutation(
  resolver: WorkspacePathResolver,
  mutation: Extract<WorkspaceMutation, { kind: "write" | "patch" }>,
): Promise<AppliedMutation> {
  const target = await resolver.writable(mutation.path);
  const previous = await snapshotFile(resolver, mutation.path);
  const missing = await missingDirectories(resolver, dirname(target.path));
  const [result] = await transactionalWrite(resolver, [
    mutation.kind === "write"
      ? { path: mutation.path, content: mutation.content }
      : { path: mutation.path, patches: mutation.hunks },
  ]);
  if (result === undefined) {
    throw new WorkspaceFileError("write_failed", "Mutation produced no result: " + mutation.path);
  }
  const applied = await readFile(target.path);
  return {
    result: {
      kind: mutation.kind,
      path: result.path,
      created: result.created,
      bytes: result.bytes,
    },
    async rollback() {
      await assertFileEquals(target.path, applied, mutation.path);
      if (previous === undefined) {
        await rm(target.path, { force: true });
        await cleanupDirectories(missing);
        return;
      }
      await transactionalWrite(resolver, [{
        path: previous.relativePath,
        content: previous.content.toString("utf8"),
      }]);
      await chmod(previous.path, previous.mode);
    },
    async commit() {},
  };
}

async function applyDelete(
  resolver: WorkspacePathResolver,
  mutation: Extract<WorkspaceMutation, { kind: "delete" }>,
): Promise<AppliedMutation> {
  const snapshot = await snapshotFile(resolver, mutation.path);
  if (snapshot === undefined) throw new WorkspaceFileError("path_not_found", mutation.path);
  if (mutation.expectedHunks !== undefined) {
    if (isProbablyBinary(snapshot.content)) throw new WorkspaceFileError("binary_file", mutation.path);
    const remainder = applyLinePatch(
      snapshot.content.toString("utf8"),
      mutation.expectedHunks,
      mutation.path,
    );
    if (remainder !== "") {
      throw new WorkspaceFileError("invalid_write", "Deletion patch did not remove the complete file: " + mutation.path);
    }
  }
  const backupPath = join(dirname(snapshot.path), ".junius-" + randomUUID() + ".del");
  let renamed = false;
  try {
    await rename(snapshot.path, backupPath);
    renamed = true;
    await assertFileEquals(backupPath, snapshot.content, mutation.path);
  } catch (error) {
    if (renamed && !(await exists(snapshot.path))) {
      await rename(backupPath, snapshot.path);
      await chmod(snapshot.path, snapshot.mode);
    }
    throw error;
  }
  return {
    result: { kind: "delete", path: snapshot.relativePath, bytes: snapshot.content.length },
    async rollback() {
      if (await exists(snapshot.path)) {
        throw new WorkspaceFileError("write_failed", "Deleted path was recreated before rollback: " + mutation.path);
      }
      await rename(backupPath, snapshot.path);
      await chmod(snapshot.path, snapshot.mode);
    },
    async commit() {
      await rm(backupPath, { force: true });
    },
  };
}

async function destinationSnapshot(
  resolver: WorkspacePathResolver,
  path: string,
  overwrite: boolean,
) {
  const target = await resolver.writable(path);
  const snapshot = await snapshotFile(resolver, path);
  if (snapshot !== undefined && !overwrite) {
    throw new WorkspaceFileError("invalid_write", "Destination already exists: " + path);
  }
  return {
    target,
    snapshot,
    missing: await missingDirectories(resolver, dirname(target.path)),
  };
}

async function backupDestination(snapshot: FileSnapshot | undefined): Promise<string | undefined> {
  if (snapshot === undefined) return undefined;
  const backupPath = join(dirname(snapshot.path), ".junius-" + randomUUID() + ".bak");
  let renamed = false;
  try {
    await rename(snapshot.path, backupPath);
    renamed = true;
    await assertFileEquals(backupPath, snapshot.content, snapshot.relativePath);
    return backupPath;
  } catch (error) {
    if (renamed && !(await exists(snapshot.path))) {
      await rename(backupPath, snapshot.path);
      await chmod(snapshot.path, snapshot.mode);
    }
    throw error;
  }
}

async function restoreDestination(
  snapshot: FileSnapshot | undefined,
  backupPath: string | undefined,
): Promise<void> {
  if (snapshot === undefined || backupPath === undefined) return;
  await rename(backupPath, snapshot.path);
  await chmod(snapshot.path, snapshot.mode);
}

async function applyMove(
  resolver: WorkspacePathResolver,
  mutation: Extract<WorkspaceMutation, { kind: "move" }>,
): Promise<AppliedMutation> {
  const source = await snapshotFile(resolver, mutation.source);
  if (source === undefined) throw new WorkspaceFileError("path_not_found", mutation.source);
  const destination = await destinationSnapshot(
    resolver,
    mutation.destination,
    mutation.overwrite === true,
  );
  if (source.path === destination.target.path) {
    throw new WorkspaceFileError("invalid_write", "Source and destination are the same path: " + mutation.source);
  }
  await mkdir(dirname(destination.target.path), { recursive: true });
  await assertParentSafe(resolver, destination.target.path, mutation.destination);
  const destinationBackup = await backupDestination(destination.snapshot);
  let moved = false;
  try {
    await assertFileEquals(source.path, source.content, mutation.source);
    if (await exists(destination.target.path)) {
      throw new WorkspaceFileError(
        "write_failed",
        "Move destination appeared after validation: " + mutation.destination,
      );
    }
    await rename(source.path, destination.target.path);
    moved = true;
    await assertFileEquals(destination.target.path, source.content, mutation.destination);
  } catch (error) {
    if (moved && !(await exists(source.path))) {
      await rename(destination.target.path, source.path);
      await chmod(source.path, source.mode);
    }
    if (destinationBackup !== undefined) {
      await restoreDestination(destination.snapshot, destinationBackup);
    }
    await cleanupDirectories(destination.missing);
    throw error;
  }
  return {
    result: {
      kind: "move",
      source: source.relativePath,
      destination: destination.target.relativePath,
      overwritten: destination.snapshot !== undefined,
      bytes: source.content.length,
    },
    async rollback() {
      await assertFileEquals(destination.target.path, source.content, mutation.destination);
      if (await exists(source.path)) {
        throw new WorkspaceFileError("write_failed", "Move source was recreated before rollback: " + mutation.source);
      }
      await rename(destination.target.path, source.path);
      await chmod(source.path, source.mode);
      await restoreDestination(destination.snapshot, destinationBackup);
      await cleanupDirectories(destination.missing);
    },
    async commit() {
      if (destinationBackup !== undefined) await rm(destinationBackup, { force: true });
    },
  };
}

async function applyCopy(
  resolver: WorkspacePathResolver,
  mutation: Extract<WorkspaceMutation, { kind: "copy" }>,
): Promise<AppliedMutation> {
  const source = await snapshotFile(resolver, mutation.source);
  if (source === undefined) throw new WorkspaceFileError("path_not_found", mutation.source);
  const destination = await destinationSnapshot(
    resolver,
    mutation.destination,
    mutation.overwrite === true,
  );
  if (source.path === destination.target.path) {
    throw new WorkspaceFileError("invalid_write", "Source and destination are the same path: " + mutation.source);
  }
  await mkdir(dirname(destination.target.path), { recursive: true });
  await assertParentSafe(resolver, destination.target.path, mutation.destination);
  const destinationBackup = await backupDestination(destination.snapshot);
  const tempPath = join(dirname(destination.target.path), ".junius-" + randomUUID() + ".tmp");
  try {
    await writeFile(tempPath, source.content, { flag: "wx" });
    await chmod(tempPath, source.mode);
    await assertFileEquals(source.path, source.content, mutation.source);
    if (await exists(destination.target.path)) {
      throw new WorkspaceFileError(
        "write_failed",
        "Copy destination appeared after validation: " + mutation.destination,
      );
    }
    await rename(tempPath, destination.target.path);
  } catch (error) {
    await rm(tempPath, { force: true });
    if (destinationBackup !== undefined) {
      await restoreDestination(destination.snapshot, destinationBackup);
    }
    await cleanupDirectories(destination.missing);
    throw error;
  }
  return {
    result: {
      kind: "copy",
      source: source.relativePath,
      destination: destination.target.relativePath,
      overwritten: destination.snapshot !== undefined,
      bytes: source.content.length,
    },
    async rollback() {
      await assertFileEquals(destination.target.path, source.content, mutation.destination);
      await rm(destination.target.path, { force: true });
      await restoreDestination(destination.snapshot, destinationBackup);
      await cleanupDirectories(destination.missing);
    },
    async commit() {
      if (destinationBackup !== undefined) await rm(destinationBackup, { force: true });
    },
  };
}

async function applyMkdir(
  resolver: WorkspacePathResolver,
  mutation: Extract<WorkspaceMutation, { kind: "mkdir" }>,
): Promise<AppliedMutation> {
  const target = await resolver.writable(mutation.path);
  if (target.exists) {
    const info = await lstat(target.path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new WorkspaceFileError("not_a_directory", mutation.path);
    }
    return {
      result: { kind: "mkdir", path: target.relativePath, created: false },
      async rollback() {},
      async commit() {},
    };
  }
  const missing = await missingDirectories(resolver, target.path);
  await mkdir(target.path, { recursive: true });
  await assertParentSafe(resolver, join(target.path, ".junius-directory-check"), mutation.path);
  return {
    result: { kind: "mkdir", path: target.relativePath, created: true },
    async rollback() {
      await cleanupDirectories(missing);
    },
    async commit() {},
  };
}

async function applyMutation(
  resolver: WorkspacePathResolver,
  mutation: WorkspaceMutation,
): Promise<AppliedMutation> {
  switch (mutation.kind) {
    case "write":
    case "patch":
      return applyTextMutation(resolver, mutation);
    case "delete":
      return applyDelete(resolver, mutation);
    case "move":
      return applyMove(resolver, mutation);
    case "copy":
      return applyCopy(resolver, mutation);
    case "mkdir":
      return applyMkdir(resolver, mutation);
  }
}

export function mutationPaths(mutations: readonly WorkspaceMutation[]): readonly string[] {
  const paths: string[] = [];
  for (const mutation of mutations) {
    if (mutation.kind === "move" || mutation.kind === "copy") {
      paths.push(mutation.source, mutation.destination);
    } else {
      paths.push(mutation.path);
    }
  }
  return paths;
}

export async function mutateWorkspace(
  resolver: WorkspacePathResolver,
  mutations: readonly WorkspaceMutation[],
): Promise<readonly WorkspaceMutationResult[]> {
  if (mutations.length < 1) {
    throw new WorkspaceFileError(
      "invalid_write",
      "Workspace mutation requires at least one operation.",
    );
  }
  const contentBytes = mutations.reduce(
    (total, mutation) => total + (mutation.kind === "write" ? Buffer.byteLength(mutation.content, "utf8") : 0),
    0,
  );
  if (contentBytes > MAX_WORKSPACE_MUTATION_BYTES) {
    throw new WorkspaceFileError(
      "write_too_large",
      "Workspace mutation content exceeds " + MAX_WORKSPACE_MUTATION_BYTES + " bytes.",
    );
  }
  const applied: AppliedMutation[] = [];
  try {
    for (const mutation of mutations) {
      applied.push(await applyMutation(resolver, mutation));
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const item of [...applied].reverse()) {
      try {
        await item.rollback();
      } catch (rollbackError) {
        rollbackErrors.push(errorMessage(rollbackError));
      }
    }
    if (error instanceof WorkspaceFileError && rollbackErrors.length === 0) throw error;
    throw new WorkspaceFileError(
      "write_failed",
      "Workspace mutation failed: " + errorMessage(error) +
        (rollbackErrors.length === 0 ? "" : "; rollback errors: " + rollbackErrors.join(" | ")),
    );
  }
  await Promise.allSettled(applied.map((item) => item.commit()));
  return applied.map((item) => item.result);
}
