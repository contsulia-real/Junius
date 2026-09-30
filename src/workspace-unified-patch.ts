import {
  WorkspaceFileError,
  type WriteRequest,
} from "./workspace-files.js";
import type {
  WritePatchHunk,
  WritePatchLine,
} from "./workspace-line-patch.js";

interface ParsedFilePatch {
  readonly path: string;
  readonly created: boolean;
  readonly hunks:
    readonly WritePatchHunk[];
}

const HUNK_HEADER =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u;

function patchError(
  message: string,
): never {
  throw new WorkspaceFileError(
    "invalid_write",
    message,
  );
}

function headerPath(
  line: string,
  prefix: "--- " | "+++ ",
): string {
  const raw =
    line.slice(
      prefix.length,
    );
  const path =
    raw.split("\t", 1)[0] ??
    "";

  if (
    path.length === 0
  ) {
    patchError(
      "Unified diff contains an empty file path.",
    );
  }

  if (
    path.startsWith('"') &&
    path.endsWith('"')
  ) {
    patchError(
      "Quoted unified-diff paths are not supported.",
    );
  }

  if (
    path === "/dev/null"
  ) {
    return path;
  }

  if (
    path.startsWith(
      "a/",
    ) ||
    path.startsWith(
      "b/",
    )
  ) {
    return path.slice(2);
  }

  return path;
}

function parseHunk(
  lines: readonly string[],
  startIndex: number,
  path: string,
): {
  readonly hunk:
    WritePatchHunk;
  readonly nextIndex:
    number;
} {
  const header =
    lines[startIndex] ??
    "";
  const match =
    HUNK_HEADER.exec(
      header,
    );

  if (match === null) {
    patchError(
      `Invalid unified-diff hunk header for ${path}: ${header}`,
    );
  }

  const oldStart =
    Number(match[1]);
  const oldCount =
    match[2] ===
    undefined
      ? 1
      : Number(match[2]);
  const newStart =
    Number(match[3]);
  const newCount =
    match[4] ===
    undefined
      ? 1
      : Number(match[4]);
  const hunkLines:
    WritePatchLine[] = [];
  let index =
    startIndex + 1;

  while (
    index < lines.length
  ) {
    const line =
      lines[index] ?? "";

    if (
      line.length === 0 ||
      line.startsWith(
        "@@ ",
      ) ||
      line.startsWith(
        "--- ",
      ) ||
      line.startsWith(
        "diff --git ",
      )
    ) {
      break;
    }

    if (
      line ===
      "\\ No newline at end of file"
    ) {
      const previous =
        hunkLines.at(-1);
      if (
        previous ===
        undefined
      ) {
        patchError(
          `No-newline marker has no preceding patch line: ${path}`,
        );
      }
      hunkLines[
        hunkLines.length - 1
      ] = {
        ...previous,
        noNewline: true,
      };
      index += 1;
      continue;
    }

    const marker =
      line[0];
    if (
      marker !== " " &&
      marker !== "+" &&
      marker !== "-"
    ) {
      patchError(
        `Invalid unified-diff line for ${path}: ${line}`,
      );
    }

    hunkLines.push({
      kind:
        marker === " "
          ? "context"
          : marker === "+"
            ? "add"
            : "remove",
      text:
        line.slice(1),
    });
    index += 1;
  }

  const observedOld =
    hunkLines.filter(
      (line) =>
        line.kind !==
        "add",
    ).length;
  const observedNew =
    hunkLines.filter(
      (line) =>
        line.kind !==
        "remove",
    ).length;

  if (
    observedOld !==
      oldCount ||
    observedNew !==
      newCount
  ) {
    patchError(
      `Unified-diff hunk counts do not match header for ${path}.`,
    );
  }

  return {
    hunk: {
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines:
        hunkLines,
    },
    nextIndex:
      index,
  };
}

export function parseUnifiedPatch(
  patch: string,
): readonly WriteRequest[] {
  const normalized =
    patch.replace(
      /\r\n/gu,
      "\n",
    );
  const lines =
    normalized.split("\n");
  const filePatches:
    ParsedFilePatch[] = [];
  let index = 0;

  while (
    index < lines.length
  ) {
    const line =
      lines[index] ?? "";

    if (
      line.length === 0 ||
      line.startsWith(
        "diff --git ",
      ) ||
      line.startsWith(
        "index ",
      ) ||
      line.startsWith(
        "new file mode ",
      ) ||
      line.startsWith(
        "deleted file mode ",
      ) ||
      line.startsWith(
        "rename from ",
      ) ||
      line.startsWith(
        "rename to ",
      ) ||
      line.startsWith(
        "old mode ",
      ) ||
      line.startsWith(
        "new mode ",
      ) ||
      line.startsWith(
        "similarity index ",
      )
    ) {
      index += 1;
      continue;
    }

    if (
      !line.startsWith(
        "--- ",
      )
    ) {
      patchError(
        `Expected unified-diff file header, found: ${line}`,
      );
    }

    const oldPath =
      headerPath(
        line,
        "--- ",
      );
    const nextHeader =
      lines[index + 1] ??
      "";
    if (
      !nextHeader
        .startsWith(
          "+++ ",
        )
    ) {
      patchError(
        `Missing +++ header after ${line}`,
      );
    }

    const newPath =
      headerPath(
        nextHeader,
        "+++ ",
      );

    if (
      newPath ===
      "/dev/null"
    ) {
      patchError(
        "File deletion is not supported by workspace_patch.",
      );
    }

    const created =
      oldPath ===
      "/dev/null";

    if (
      !created &&
      oldPath !== newPath
    ) {
      patchError(
        `File rename is not supported by workspace_patch: ${oldPath} -> ${newPath}`,
      );
    }

    index += 2;
    const hunks:
      WritePatchHunk[] = [];

    while (
      index < lines.length &&
      (
        lines[index] ??
        ""
      ).startsWith(
        "@@ ",
      )
    ) {
      const parsed =
        parseHunk(
          lines,
          index,
          newPath,
        );
      hunks.push(
        parsed.hunk,
      );
      index =
        parsed.nextIndex;
    }

    if (
      hunks.length === 0
    ) {
      patchError(
        `Unified diff has no hunks for ${newPath}.`,
      );
    }

    filePatches.push({
      path: newPath,
      created,
      hunks,
    });
  }

  if (
    filePatches.length ===
      0
  ) {
    patchError(
      "Unified diff contains no file patches.",
    );
  }

  if (
    filePatches.length >
    16
  ) {
    patchError(
      "workspace_patch accepts at most 16 files per patch.",
    );
  }

  const paths =
    new Set<string>();

  for (
    const filePatch of
    filePatches
  ) {
    const key =
      process.platform ===
      "win32"
        ? filePatch.path
            .toLowerCase()
        : filePatch.path;
    if (paths.has(key)) {
      patchError(
        `Duplicate patch target: ${filePatch.path}`,
      );
    }
    paths.add(key);

    if (
      filePatch.created &&
      (
        filePatch.hunks[0]
          ?.oldStart !== 0 ||
        filePatch.hunks[0]
          ?.oldCount !== 0
      )
    ) {
      patchError(
        `New-file patch must begin from an empty source: ${filePatch.path}`,
      );
    }
  }

  return filePatches.map(
    (filePatch) => ({
      path:
        filePatch.path,
      patches:
        filePatch.hunks,
    }),
  );
}
