import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { WorkspaceFileError } from "./workspace-file-error.js";
import {
  pathSegments,
  type WorkspacePathResolver,
} from "./workspace-path-resolver.js";

export const MAX_READ_FILES = 16;
const MAX_READ_LINES_PER_FILE = 2_000;

export interface LsEntry {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly size?: number;
}

export async function listDirectory(
  resolver: WorkspacePathResolver,
  inputPath: string,
  depth: number,
): Promise<readonly LsEntry[]> {
  const target = await resolver.existing(inputPath);
  const targetStat = await stat(target.path);
  if (!targetStat.isDirectory()) {
    throw new WorkspaceFileError("not_a_directory", inputPath);
  }

  const results: LsEntry[] = [];

  async function visit(directory: string, remainingDepth: number): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      const rel = relative(resolver.rootPath, fullPath);

      if (
        pathSegments(rel)[0]?.toLowerCase() ===
          ".junius" ||
        pathSegments(rel).some(
          (segment) =>
            segment.toLowerCase() === ".git",
        ) ||
        resolver.isProtectedPath(fullPath)
      ) {
        continue;
      }

      let type: LsEntry["type"] = "other";
      let size: number | undefined;

      if (entry.isSymbolicLink()) {
        type = "symlink";
      } else if (entry.isDirectory()) {
        type = "directory";
      } else if (entry.isFile()) {
        type = "file";
        size = (await stat(fullPath)).size;
      }

      results.push({
        path: rel,
        type,
        ...(size === undefined ? {} : { size }),
      });

      if (entry.isDirectory() && remainingDepth > 1) {
        await visit(fullPath, remainingDepth - 1);
      }
    }
  }

  await visit(target.path, depth);
  return results;
}

export function isProbablyBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8_192);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

export interface ReadRequest {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface ReadResult {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly content: string;
}

export async function readTextFile(
  resolver: WorkspacePathResolver,
  request: ReadRequest,
): Promise<ReadResult> {
  const target = await resolver.existing(request.path);
  const info = await stat(target.path);
  if (!info.isFile()) {
    throw new WorkspaceFileError("not_a_file", request.path);
  }

  const buffer = await readFile(target.path);
  if (isProbablyBinary(buffer)) {
    throw new WorkspaceFileError("binary_file", request.path);
  }

  const text = buffer.toString("utf8");
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }

  const totalLines = lineStarts.length;
  const startLine = request.startLine ?? 1;
  const requestedEnd =
    request.endLine ?? Math.min(totalLines, startLine + 399);
  const endLine = Math.min(
    totalLines,
    requestedEnd,
    startLine + MAX_READ_LINES_PER_FILE - 1,
  );

  if (
    startLine < 1 ||
    startLine > totalLines ||
    endLine < startLine
  ) {
    throw new WorkspaceFileError(
      "invalid_path",
      `Invalid line range for ${request.path}: ${startLine}-${requestedEnd}`,
    );
  }

  const startOffset = lineStarts[startLine - 1] ?? 0;
  const endOffset =
    endLine < totalLines
      ? (lineStarts[endLine] ?? text.length)
      : text.length;

  return {
    path: target.relativePath,
    startLine,
    endLine,
    totalLines,
    content: text.slice(startOffset, endOffset),
  };
}
