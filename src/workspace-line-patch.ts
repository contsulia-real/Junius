import {
  WorkspaceFileError,
} from "./workspace-file-error.js";

export type WritePatchLineKind =
  | "context"
  | "add"
  | "remove";

export interface WritePatchLine {
  readonly kind:
    WritePatchLineKind;
  readonly text: string;
  readonly noNewline?:
    boolean;
}

export interface WritePatchHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines:
    readonly WritePatchLine[];
}

function splitTextLines(
  text: string,
): {
  readonly lines:
    readonly string[];
  readonly eol: string;
  readonly finalNewline:
    boolean;
} {
  const eol =
    text.includes("\r\n")
      ? "\r\n"
      : "\n";
  const finalNewline =
    text.endsWith("\n");
  const lines =
    text.length === 0
      ? []
      : text
          .split(/\r?\n/u);

  if (
    finalNewline &&
    lines.at(-1) === ""
  ) {
    lines.pop();
  }

  return {
    lines,
    eol,
    finalNewline,
  };
}

export function applyLinePatch(
  sourceText: string,
  hunks:
    readonly WritePatchHunk[],
  path: string,
): string {
  const source =
    splitTextLines(
      sourceText,
    );
  const output:
    string[] = [];
  let sourceIndex = 0;
  let lastOutputNoNewline =
    false;
  let touchedEnd =
    false;

  for (
    let hunkIndex = 0;
    hunkIndex <
      hunks.length;
    hunkIndex += 1
  ) {
    const hunk =
      hunks[hunkIndex]!;
    const targetIndex =
      hunk.oldCount === 0
        ? hunk.oldStart
        : hunk.oldStart - 1;

    if (
      targetIndex <
        sourceIndex ||
      targetIndex >
        source.lines.length
    ) {
      throw new WorkspaceFileError(
        "edit_not_found",
        `Patch hunk ${hunkIndex + 1} has an invalid source position: ${path}`,
      );
    }

    output.push(
      ...source.lines.slice(
        sourceIndex,
        targetIndex,
      ),
    );
    sourceIndex =
      targetIndex;

    let observedOld = 0;
    let observedNew = 0;

    for (
      const line of
      hunk.lines
    ) {
      if (
        line.kind ===
          "add"
      ) {
        output.push(
          line.text,
        );
        observedNew += 1;
        lastOutputNoNewline =
          line.noNewline ===
          true;
        continue;
      }

      const actual =
        source.lines[
          sourceIndex
        ];
      if (
        actual ===
        undefined ||
        actual !== line.text
      ) {
        throw new WorkspaceFileError(
          "edit_not_found",
          `Patch hunk ${hunkIndex + 1} context did not match line ${sourceIndex + 1}: ${path}`,
        );
      }

      if (
        line.noNewline ===
          true &&
        (
          sourceIndex !==
            source.lines
              .length - 1 ||
          source.finalNewline
        )
      ) {
        throw new WorkspaceFileError(
          "edit_not_found",
          `Patch hunk ${hunkIndex + 1} no-newline marker did not match source: ${path}`,
        );
      }

      sourceIndex += 1;
      observedOld += 1;

      if (
        line.kind ===
          "context"
      ) {
        output.push(
          line.text,
        );
        observedNew += 1;
        lastOutputNoNewline =
          line.noNewline ===
          true;
      }
    }

    if (
      observedOld !==
        hunk.oldCount ||
      observedNew !==
        hunk.newCount
    ) {
      throw new WorkspaceFileError(
        "invalid_write",
        `Patch hunk ${hunkIndex + 1} line counts do not match its header: ${path}`,
      );
    }

    touchedEnd =
      sourceIndex ===
      source.lines.length;
  }

  output.push(
    ...source.lines.slice(
      sourceIndex,
    ),
  );

  if (
    sourceIndex <
    source.lines.length
  ) {
    lastOutputNoNewline =
      !source.finalNewline;
    touchedEnd = false;
  }

  if (output.length === 0) {
    return "";
  }

  const finalNewline =
    touchedEnd
      ? !lastOutputNoNewline
      : source.finalNewline;

  return (
    output.join(
      source.eol,
    ) +
    (
      finalNewline
        ? source.eol
        : ""
    )
  );
}
