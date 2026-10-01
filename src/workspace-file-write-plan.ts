import { readFile, stat } from "node:fs/promises";
import { WorkspaceFileError } from "./workspace-file-error.js";
import type { WorkspacePathResolver } from "./workspace-path-resolver.js";
import { isProbablyBinary } from "./workspace-file-read.js";
import { applyLinePatch, type WritePatchHunk } from "./workspace-line-patch.js";

const MAX_WRITE_BYTES_PER_FILE = 2 * 1024 * 1024;
const MAX_WRITE_BYTES_TOTAL = 8 * 1024 * 1024;

export interface WriteRequest {
  readonly path: string;
  readonly content?: string;
  readonly patches?: readonly WritePatchHunk[];
}

export interface WriteResult {
  readonly path: string;
  readonly created: boolean;
  readonly bytes: number;
}

export interface PreparedWrite {
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
  const hasPatches = request.patches !== undefined;
  if (Number(hasContent) + Number(hasPatches) !== 1) {
    throw new WorkspaceFileError(
      "invalid_write",
      "write requires exactly one of content or patches: " + request.path,
    );
  }
  if (request.patches !== undefined && request.patches.length === 0) {
    throw new WorkspaceFileError("invalid_write", "patches must not be empty: " + request.path);
  }

  const target = await resolver.writable(request.path);
  if (!target.exists) {
    const nextText = request.content ?? applyLinePatch("", request.patches ?? [], request.path);
    const content = Buffer.from(nextText, "utf8");
    if (content.length > MAX_WRITE_BYTES_PER_FILE) {
      throw new WorkspaceFileError(
        "write_too_large",
        "Write exceeds " + MAX_WRITE_BYTES_PER_FILE + " bytes: " + request.path,
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
  if (!info.isFile()) throw new WorkspaceFileError("not_a_file", request.path);
  const previous = await readFile(target.path);
  if (isProbablyBinary(previous)) throw new WorkspaceFileError("binary_file", request.path);

  const nextText = request.content !== undefined
    ? request.content
    : applyLinePatch(previous.toString("utf8"), request.patches ?? [], request.path);
  const content = Buffer.from(nextText, "utf8");
  if (content.length > MAX_WRITE_BYTES_PER_FILE) {
    throw new WorkspaceFileError(
      "write_too_large",
      "Write exceeds " + MAX_WRITE_BYTES_PER_FILE + " bytes: " + request.path,
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

export async function prepareWriteSet(
  resolver: WorkspacePathResolver,
  requests: readonly WriteRequest[],
): Promise<readonly PreparedWrite[]> {
  if (requests.length === 0) {
    throw new WorkspaceFileError("invalid_write", "write requires at least one request.");
  }
  const prepared = await Promise.all(requests.map((request) => validateWrite(resolver, request)));
  const targets = new Set<string>();
  let totalBytes = 0;
  for (const item of prepared) {
    totalBytes += item.content.length;
    if (totalBytes > MAX_WRITE_BYTES_TOTAL) {
      throw new WorkspaceFileError(
        "write_too_large",
        "write exceeds " + MAX_WRITE_BYTES_TOTAL + " total bytes.",
      );
    }
    const key = writePathKey(item.targetPath);
    if (targets.has(key)) {
      throw new WorkspaceFileError("invalid_write", "Duplicate write target: " + item.relativePath);
    }
    targets.add(key);
  }
  return prepared;
}
