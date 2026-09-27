import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { accessSync, constants } from "node:fs";
import { WorkspaceManager } from "./workspace-manager.js";

const MAX_READ_FILES = 16;
const MAX_READ_LINES_PER_FILE = 2_000;
const MAX_WRITE_FILES = 16;
const MAX_WRITE_BYTES_PER_FILE = 2 * 1024 * 1024;
const MAX_WRITE_BYTES_TOTAL = 8 * 1024 * 1024;
const RG_TIMEOUT_MS = 15_000;
const RG_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type WorkspaceFileErrorCode =
  | "workspace_not_registered"
  | "invalid_path"
  | "path_outside_workspace"
  | "path_not_found"
  | "not_a_directory"
  | "not_a_file"
  | "binary_file"
  | "invalid_write"
  | "edit_not_found"
  | "edit_not_unique"
  | "write_too_large"
  | "write_failed"
  | "rg_not_available"
  | "rg_failed";

export class WorkspaceFileError extends Error {
  constructor(
    readonly code: WorkspaceFileErrorCode,
    message: string,
  ) {
    super(message);
  }
}


function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertRelativeWorkspacePath(input: string): string {
  if (input.includes("\0") || isAbsolute(input)) {
    throw new WorkspaceFileError("invalid_path", `Invalid Workspace-relative path: ${input}`);
  }

  const normalized = input.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);

  if (segments.some((segment) => segment === "..")) {
    throw new WorkspaceFileError("invalid_path", `Path traversal is not allowed: ${input}`);
  }

  return segments.length === 0 ? "." : segments.join("/");
}

async function findExistingAncestor(path: string): Promise<string> {
  let current = path;

  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new WorkspaceFileError("path_not_found", `No existing ancestor for: ${path}`);
    }
    current = parent;
  }
}

export class WorkspacePathResolver {
  constructor(readonly rootPath: string) {}

  async existing(input: string): Promise<{
    readonly path: string;
    readonly relativePath: string;
  }> {
    const relativePath = assertRelativeWorkspacePath(input);
    const lexical = resolve(this.rootPath, relativePath);

    if (!pathInside(this.rootPath, lexical)) {
      throw new WorkspaceFileError("path_outside_workspace", input);
    }

    let canonical: string;
    try {
      canonical = await realpath(lexical);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new WorkspaceFileError("path_not_found", input);
      }
      throw error;
    }

    if (!pathInside(this.rootPath, canonical)) {
      throw new WorkspaceFileError("path_outside_workspace", input);
    }

    return {
      path: canonical,
      relativePath: relative(this.rootPath, canonical) || ".",
    };
  }

  async writable(input: string): Promise<{
    readonly path: string;
    readonly relativePath: string;
    readonly exists: boolean;
  }> {
    const relativePath = assertRelativeWorkspacePath(input);
    const lexical = resolve(this.rootPath, relativePath);

    if (!pathInside(this.rootPath, lexical)) {
      throw new WorkspaceFileError("path_outside_workspace", input);
    }

    try {
      const canonical = await realpath(lexical);
      if (!pathInside(this.rootPath, canonical)) {
        throw new WorkspaceFileError("path_outside_workspace", input);
      }

      const info = await lstat(lexical);
      if (info.isSymbolicLink()) {
        throw new WorkspaceFileError(
          "invalid_path",
          `Writing through a symbolic link is not allowed: ${input}`,
        );
      }

      return {
        path: lexical,
        relativePath,
        exists: true,
      };
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

    const ancestor = await findExistingAncestor(dirname(lexical));
    const canonicalAncestor = await realpath(ancestor);
    if (!pathInside(this.rootPath, canonicalAncestor)) {
      throw new WorkspaceFileError("path_outside_workspace", input);
    }

    return {
      path: lexical,
      relativePath,
      exists: false,
    };
  }
}

function getResolver(
  manager: WorkspaceManager,
  workspace: string,
): WorkspacePathResolver {
  const profile = manager.get(workspace);
  if (profile === undefined) {
    throw new WorkspaceFileError(
      "workspace_not_registered",
      `Workspace is not registered: ${workspace}`,
    );
  }

  return new WorkspacePathResolver(profile.rootPath);
}

export interface LsEntry {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly size?: number;
}

async function listDirectory(
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

function isProbablyBinary(buffer: Buffer): boolean {
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

async function readTextFile(
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

async function transactionalWrite(
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

function resolveRgExecutable(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const names =
    process.platform === "win32"
      ? ["rg.exe", "rg"]
      : ["rg"];

  for (const rawEntry of (environment.PATH ?? "").split(delimiter)) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    for (const name of names) {
      const candidate = join(entry, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching.
      }
    }
  }

  return undefined;
}

interface RgMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly submatches: readonly {
    readonly start: number;
    readonly end: number;
    readonly text: string;
  }[];
}

function parseRgJson(
  output: string,
  workspaceRoot: string,
  maxResults: number,
): readonly RgMatch[] {
  const matches: RgMatch[] = [];

  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;

    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    if (
      typeof event !== "object" ||
      event === null ||
      !("type" in event) ||
      event.type !== "match" ||
      !("data" in event) ||
      typeof event.data !== "object" ||
      event.data === null
    ) {
      continue;
    }

    const data = event.data as {
      path?: { text?: string };
      lines?: { text?: string };
      line_number?: number;
      submatches?: {
        start?: number;
        end?: number;
        match?: { text?: string };
      }[];
    };

    const pathText = data.path?.text;
    const lineNumber = data.line_number;
    if (typeof pathText !== "string" || typeof lineNumber !== "number") {
      continue;
    }

    matches.push({
      path: isAbsolute(pathText)
        ? relative(workspaceRoot, pathText)
        : pathText,
      line: lineNumber,
      text: (data.lines?.text ?? "").replace(/\r?\n$/u, ""),
      submatches: (data.submatches ?? []).flatMap((match) =>
        typeof match.start === "number" &&
        typeof match.end === "number" &&
        typeof match.match?.text === "string"
          ? [{
              start: match.start,
              end: match.end,
              text: match.match.text,
            }]
          : [],
      ),
    });

    if (matches.length >= maxResults) {
      break;
    }
  }

  return matches;
}

async function runRg(
  resolver: WorkspacePathResolver,
  options: {
    readonly query: string;
    readonly path: string;
    readonly globs: readonly string[];
    readonly caseSensitive: boolean;
    readonly fixedStrings: boolean;
    readonly hidden: boolean;
    readonly maxResults: number;
  },
): Promise<readonly RgMatch[]> {
  const executable = resolveRgExecutable();
  if (executable === undefined) {
    throw new WorkspaceFileError(
      "rg_not_available",
      "ripgrep (rg) was not found on PATH.",
    );
  }

  const target = await resolver.existing(options.path);
  const args = [
    "--json",
    "--color=never",
    "--no-config",
  ];

  if (!options.caseSensitive) args.push("-i");
  if (options.fixedStrings) args.push("-F");
  if (options.hidden) args.push("--hidden");

  for (const glob of options.globs) {
    args.push("-g", glob);
  }

  args.push("--", options.query, target.path);

  const result = await new Promise<{
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly outputLimit: boolean;
  }>((resolvePromise) => {
    const child = spawn(executable, args, {
      cwd: resolver.rootPath,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RIPGREP_CONFIG_PATH: "",
      },
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let outputLimit = false;
    let settled = false;

    const timer = setTimeout(() => {
      child.kill();
    }, RG_TIMEOUT_MS);

    const append = (targetChunks: Buffer[], chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > RG_MAX_OUTPUT_BYTES) {
        outputLimit = true;
        child.kill();
        return;
      }
      targetChunks.push(buffer);
    };

    child.stdout.on("data", (chunk: Buffer | string) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer | string) => append(stderr, chunk));

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: error.message,
        outputLimit,
      });
    });

    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        outputLimit,
      });
    });
  });

  if (result.outputLimit) {
    throw new WorkspaceFileError(
      "rg_failed",
      `rg output exceeded ${RG_MAX_OUTPUT_BYTES} bytes.`,
    );
  }

  // ripgrep uses 1 for "no matches".
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new WorkspaceFileError(
      "rg_failed",
      result.stderr || `rg exited with code ${String(result.exitCode)}.`,
    );
  }

  return parseRgJson(result.stdout, resolver.rootPath, options.maxResults);
}

export class WorkspaceFilesService {
  constructor(private readonly manager: WorkspaceManager) {}

  async ls(
    workspace: string,
    path = ".",
    depth = 1,
  ): Promise<readonly LsEntry[]> {
    return listDirectory(getResolver(this.manager, workspace), path, depth);
  }

  async read(
    workspace: string,
    files: readonly ReadRequest[],
  ): Promise<readonly ReadResult[]> {
    if (files.length < 1 || files.length > MAX_READ_FILES) {
      throw new WorkspaceFileError(
        "invalid_path",
        `read accepts 1-${MAX_READ_FILES} files per call.`,
      );
    }

    const resolver = getResolver(this.manager, workspace);
    return Promise.all(files.map((file) => readTextFile(resolver, file)));
  }

  async write(
    workspace: string,
    files: readonly WriteRequest[],
  ): Promise<readonly WriteResult[]> {
    if (files.length < 1 || files.length > MAX_WRITE_FILES) {
      throw new WorkspaceFileError(
        "invalid_path",
        `write accepts 1-${MAX_WRITE_FILES} files per call.`,
      );
    }

    return transactionalWrite(
      getResolver(this.manager, workspace),
      files,
    );
  }

  async rg(
    workspace: string,
    options: {
      readonly query: string;
      readonly path?: string;
      readonly globs?: readonly string[];
      readonly caseSensitive?: boolean;
      readonly fixedStrings?: boolean;
      readonly hidden?: boolean;
      readonly maxResults?: number;
    },
  ): Promise<readonly RgMatch[]> {
    const maxResults = Math.max(1, Math.min(options.maxResults ?? 100, 500));

    return runRg(getResolver(this.manager, workspace), {
      query: options.query,
      path: options.path ?? ".",
      globs: options.globs ?? [],
      caseSensitive: options.caseSensitive ?? true,
      fixedStrings: options.fixedStrings ?? false,
      hidden: options.hidden ?? false,
      maxResults,
    });
  }
}
