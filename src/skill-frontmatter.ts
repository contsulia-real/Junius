import {
  TextDecoder,
} from "node:util";
import { SkillError } from "./skill-errors.js";

export interface SkillManifest {
  readonly name: string;
  readonly description: string;
}

const decoder =
  new TextDecoder("utf-8", {
    fatal: true,
  });

function scalarValue(
  value: string,
): string {
  const trimmed = value.trim();

  if (
    trimmed.startsWith('"') &&
    trimmed.endsWith('"') &&
    trimmed.length >= 2
  ) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      throw new SkillError(
        "invalid_skill",
        "SKILL.md contains an invalid quoted frontmatter scalar.",
      );
    }
  }

  if (
    trimmed.startsWith("'") &&
    trimmed.endsWith("'") &&
    trimmed.length >= 2
  ) {
    return trimmed
      .slice(1, -1)
      .replaceAll("''", "'");
  }

  return trimmed;
}

function blockValue(
  lines: readonly string[],
  start: number,
  folded: boolean,
): {
  readonly value: string;
  readonly next: number;
} {
  const collected: string[] = [];
  let minimumIndent:
    number | undefined;
  let index = start;

  for (
    ;
    index < lines.length;
    index += 1
  ) {
    const line = lines[index] ?? "";

    if (line.trim().length === 0) {
      collected.push("");
      continue;
    }

    const indent =
      line.length -
      line.trimStart().length;
    if (indent === 0) {
      break;
    }
    minimumIndent =
      minimumIndent === undefined
        ? indent
        : Math.min(
            minimumIndent,
            indent,
          );
    collected.push(line);
  }

  const indent =
    minimumIndent ?? 0;
  const normalized =
    collected.map((line) =>
      line.length === 0
        ? ""
        : line.slice(indent),
    );

  return {
    value: folded
      ? normalized
          .join("\n")
          .replace(
            /(?<!\n)\n(?!\n)/gu,
            " ",
          )
          .trim()
      : normalized.join("\n").trim(),
    next: index,
  };
}

export function decodeSkillText(
  content: Buffer,
  path = "SKILL.md",
): string {
  try {
    return decoder.decode(content);
  } catch {
    throw new SkillError(
      "invalid_skill",
      `Skill text is not valid UTF-8: ${path}`,
    );
  }
}

export function parseSkillManifest(
  content: string,
): SkillManifest {
  const normalized =
    content.replace(/\r\n/gu, "\n");
  const lines =
    normalized.split("\n");

  if (
    lines[0]?.trim() !== "---"
  ) {
    throw new SkillError(
      "invalid_skill",
      "SKILL.md must begin with YAML frontmatter.",
    );
  }

  const closing =
    lines.findIndex(
      (line, index) =>
        index > 0 &&
        line.trim() === "---",
    );
  if (closing < 0) {
    throw new SkillError(
      "invalid_skill",
      "SKILL.md frontmatter is not closed.",
    );
  }

  const values =
    new Map<string, string>();
  const recognizedKeys =
    new Set([
      "name",
      "description",
      "license",
      "compatibility",
      "metadata",
      "allowed-tools",
    ]);
  const seenRecognized =
    new Set<string>();

  let index = 1;
  while (index < closing) {
    const line =
      lines[index] ?? "";

    if (
      line.trim().length === 0 ||
      line.trimStart()
        .startsWith("#")
    ) {
      index += 1;
      continue;
    }

    if (
      line.length !==
      line.trimStart().length
    ) {
      index += 1;
      continue;
    }

    const colon =
      line.indexOf(":");
    if (colon <= 0) {
      index += 1;
      continue;
    }

    const key =
      line.slice(0, colon).trim();
    const raw =
      line.slice(colon + 1).trim();
    const normalizedKey =
      key.toLowerCase();

    if (
      recognizedKeys.has(
        normalizedKey,
      )
    ) {
      if (
        key !== normalizedKey
      ) {
        throw new SkillError(
          "invalid_skill",
          `Recognized SKILL.md frontmatter field must use lowercase spelling: ${key}`,
        );
      }
      if (
        seenRecognized.has(
          normalizedKey,
        )
      ) {
        throw new SkillError(
          "invalid_skill",
          `Duplicate SKILL.md frontmatter field: ${key}`,
        );
      }
      seenRecognized.add(
        normalizedKey,
      );
    }

    if (
      raw === "|" ||
      raw === ">" ||
      raw === "|-" ||
      raw === ">-" ||
      raw === "|+" ||
      raw === ">+"
    ) {
      const block =
        blockValue(
          lines.slice(0, closing),
          index + 1,
          raw.startsWith(">"),
        );
      values.set(
        key,
        block.value,
      );
      index = block.next;
      continue;
    }

    if (
      (
        normalizedKey === "name" ||
        normalizedKey === "description"
      ) &&
      (
        /^[\[{]/u.test(raw) ||
        /^(?:null|~|true|false)$/iu.test(raw) ||
        /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(raw)
      )
    ) {
      throw new SkillError(
        "invalid_skill",
        `SKILL.md frontmatter field ${key} must be a string.`,
      );
    }

    values.set(
      key,
      scalarValue(raw),
    );
    index += 1;
  }

  const body =
    lines
      .slice(closing + 1)
      .join("\n")
      .trim();

  const name =
    values.get("name")?.trim();
  const description =
    values
      .get("description")
      ?.trim();

  if (!name) {
    throw new SkillError(
      "invalid_skill",
      "SKILL.md frontmatter must define a non-empty name.",
    );
  }
  if (
    name.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)
  ) {
    throw new SkillError(
      "invalid_skill",
      `Skill name must use 1-64 lowercase letters, numbers, and single hyphens: ${name}`,
    );
  }
  if (!description) {
    throw new SkillError(
      "invalid_skill",
      `Skill ${name} must define a non-empty description.`,
    );
  }
  if (
    description.length >
    1_024
  ) {
    throw new SkillError(
      "invalid_skill",
      `Skill ${name} description exceeds 1024 characters.`,
    );
  }
  if (!body) {
    throw new SkillError(
      "invalid_skill",
      `Skill ${name} must contain non-empty instructions after frontmatter.`,
    );
  }

  return {
    name,
    description,
  };
}
