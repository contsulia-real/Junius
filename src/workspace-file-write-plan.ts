import {
  readFile,
  stat,
} from "node:fs/promises";
import { WorkspaceFileError } from "./workspace-file-error.js";
import type { WorkspacePathResolver } from "./workspace-path-resolver.js";
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

export async function prepareWriteSet(
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

