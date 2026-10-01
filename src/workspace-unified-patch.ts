import { WorkspaceFileError } from "./workspace-file-error.js";
import type { WorkspaceMutation } from "./workspace-mutation.js";
import type { WritePatchHunk, WritePatchLine } from "./workspace-line-patch.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u;

function patchError(message: string): never {
  throw new WorkspaceFileError("invalid_write", message);
}

function decodeGitQuotedPath(path: string): string {
  if (
    !path.startsWith('"') ||
    !path.endsWith('"')
  ) {
    return path;
  }

  const body = path.slice(1, -1);
  const bytes: number[] = [];

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] ?? "";

    if (character !== "\\") {
      const codePoint = body.codePointAt(index);
      if (codePoint === undefined) continue;
      bytes.push(
        ...Buffer.from(
          String.fromCodePoint(codePoint),
          "utf8",
        ),
      );
      if (codePoint > 0xffff) index += 1;
      continue;
    }

    const escaped = body[index + 1];
    if (escaped === undefined) {
      patchError(
        "Quoted unified-diff path ends with an incomplete escape.",
      );
    }

    const simpleEscapes: Readonly<Record<string, string>> = {
      a: "\u0007",
      b: "\b",
      t: "\t",
      n: "\n",
      v: "\u000b",
      f: "\f",
      r: "\r",
      "\\": "\\",
      '"': '"',
    };
    const simple = simpleEscapes[escaped];
    if (simple !== undefined) {
      bytes.push(...Buffer.from(simple, "utf8"));
      index += 1;
      continue;
    }

    if (/^[0-7]$/u.test(escaped)) {
      const octal = body.slice(index + 1, index + 4);
      if (!/^[0-7]{3}$/u.test(octal)) {
        patchError(
          "Quoted unified-diff path contains an incomplete octal escape.",
        );
      }
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }

    patchError(
      "Quoted unified-diff path contains an unsupported escape: \\" +
        escaped,
    );
  }

  return Buffer.from(bytes).toString("utf8");
}

function normalizePatchPath(path: string): string {
  if (path.length === 0) patchError("Unified diff contains an empty file path.");
  const decoded = decodeGitQuotedPath(path);
  if (decoded === "/dev/null") return decoded;
  if (decoded.startsWith("a/") || decoded.startsWith("b/")) return decoded.slice(2);
  return decoded;
}

function headerPath(line: string, prefix: "--- " | "+++ "): string {
  const raw = line.slice(prefix.length);
  const path = raw.split("\t", 1)[0] ?? "";
  return normalizePatchPath(path);
}

function metadataPath(line: string, prefix: "rename from " | "rename to "): string {
  return normalizePatchPath(line.slice(prefix.length));
}

function parseHunk(
  lines: readonly string[],
  startIndex: number,
  path: string,
): { readonly hunk: WritePatchHunk; readonly nextIndex: number } {
  const header = lines[startIndex] ?? "";
  const match = HUNK_HEADER.exec(header);
  if (match === null) patchError("Invalid unified-diff hunk header for " + path + ": " + header);

  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  const hunkLines: WritePatchLine[] = [];
  let index = startIndex + 1;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (
      line.length === 0 ||
      line.startsWith("@@ ") ||
      line.startsWith("--- ") ||
      line.startsWith("diff --git ")
    ) {
      break;
    }
    if (line === "\\ No newline at end of file") {
      const previous = hunkLines.at(-1);
      if (previous === undefined) patchError("No-newline marker has no preceding patch line: " + path);
      hunkLines[hunkLines.length - 1] = { ...previous, noNewline: true };
      index += 1;
      continue;
    }
    const marker = line[0];
    if (marker !== " " && marker !== "+" && marker !== "-") {
      patchError("Invalid unified-diff line for " + path + ": " + line);
    }
    hunkLines.push({
      kind: marker === " " ? "context" : marker === "+" ? "add" : "remove",
      text: line.slice(1),
    });
    index += 1;
  }

  const observedOld = hunkLines.filter((line) => line.kind !== "add").length;
  const observedNew = hunkLines.filter((line) => line.kind !== "remove").length;
  if (observedOld !== oldCount || observedNew !== newCount) {
    patchError("Unified-diff hunk counts do not match header for " + path + ".");
  }
  return {
    hunk: { oldStart, oldCount, newStart, newCount, lines: hunkLines },
    nextIndex: index,
  };
}

function assertRenameMetadata(
  oldPath: string,
  newPath: string,
  renameFrom: string | undefined,
  renameTo: string | undefined,
): void {
  if (renameFrom === undefined && renameTo === undefined) return;
  if (renameFrom === undefined || renameTo === undefined) {
    patchError("Incomplete rename metadata in unified diff.");
  }
  if (renameFrom !== oldPath || renameTo !== newPath) {
    patchError(
      "Rename metadata does not match file headers: " + renameFrom + " -> " + renameTo +
        " versus " + oldPath + " -> " + newPath,
    );
  }
}

export function parseUnifiedPatch(patch: string): readonly WorkspaceMutation[] {
  const normalized = patch.replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  const mutations: WorkspaceMutation[] = [];
  let index = 0;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let sectionHasHeaders = false;

  function flushPureRename(): void {
    if (renameFrom === undefined && renameTo === undefined) return;
    if (renameFrom === undefined || renameTo === undefined) {
      patchError("Incomplete rename metadata in unified diff.");
    }
    if (!sectionHasHeaders) {
      mutations.push({
        kind: "move",
        source: renameFrom,
        destination: renameTo,
      });
    }
    renameFrom = undefined;
    renameTo = undefined;
    sectionHasHeaders = false;
  }

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.startsWith("diff --git ")) {
      flushPureRename();
      sectionHasHeaders = false;
      index += 1;
      continue;
    }
    if (line.startsWith("rename from ")) {
      renameFrom = metadataPath(line, "rename from ");
      index += 1;
      continue;
    }
    if (line.startsWith("rename to ")) {
      renameTo = metadataPath(line, "rename to ");
      index += 1;
      continue;
    }
    if (
      line.length === 0 ||
      line.startsWith("index ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("dissimilarity index ")
    ) {
      index += 1;
      continue;
    }
    if (!line.startsWith("--- ")) {
      patchError("Expected unified-diff file header, found: " + line);
    }

    const oldPath = headerPath(line, "--- ");
    const nextHeader = lines[index + 1] ?? "";
    if (!nextHeader.startsWith("+++ ")) patchError("Missing +++ header after " + line);
    const newPath = headerPath(nextHeader, "+++ ");
    index += 2;
    const hunks: WritePatchHunk[] = [];
    while (index < lines.length && (lines[index] ?? "").startsWith("@@ ")) {
      const parsed = parseHunk(lines, index, newPath === "/dev/null" ? oldPath : newPath);
      hunks.push(parsed.hunk);
      index = parsed.nextIndex;
    }

    sectionHasHeaders = true;
    if (oldPath === "/dev/null") {
      if (newPath === "/dev/null") patchError("Unified diff cannot create and delete /dev/null.");
      if (hunks.length === 0) patchError("New-file patch has no hunks for " + newPath + ".");
      if (hunks[0]?.oldStart !== 0 || hunks[0]?.oldCount !== 0) {
        patchError("New-file patch must begin from an empty source: " + newPath);
      }
      mutations.push({ kind: "patch", path: newPath, hunks });
      renameFrom = undefined;
      renameTo = undefined;
      continue;
    }

    if (newPath === "/dev/null") {
      if (hunks.length === 0) patchError("Deletion patch has no hunks for " + oldPath + ".");
      mutations.push({ kind: "delete", path: oldPath, expectedHunks: hunks });
      renameFrom = undefined;
      renameTo = undefined;
      continue;
    }

    if (oldPath !== newPath) {
      assertRenameMetadata(oldPath, newPath, renameFrom, renameTo);
      mutations.push({ kind: "move", source: oldPath, destination: newPath });
      if (hunks.length > 0) mutations.push({ kind: "patch", path: newPath, hunks });
      renameFrom = undefined;
      renameTo = undefined;
      continue;
    }

    if (renameFrom !== undefined || renameTo !== undefined) {
      patchError("Rename metadata is inconsistent with unchanged file headers: " + oldPath);
    }
    if (hunks.length === 0) patchError("Unified diff has no hunks for " + newPath + ".");
    mutations.push({ kind: "patch", path: newPath, hunks });
  }

  flushPureRename();
  if (mutations.length === 0) patchError("Unified diff contains no file mutations.");
  return mutations;
}
