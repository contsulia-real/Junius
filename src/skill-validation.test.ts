import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SkillError,
} from "./skill-errors.js";
import {
  assertSkillTreeSafe,
  readSkillTextFile,
} from "./skill-files.js";
import {
  parseSkillManifest,
} from "./skill-frontmatter.js";

function skillText(
  name: string,
  description: string,
  body = "# Instructions\nDo the work.\n",
): string {
  return [
    "---",
    "name: " + name,
    "description: " + description,
    "---",
    "",
    body,
  ].join("\n");
}

test("Agent Skill manifest accepts the standard name and description shape", () => {
  assert.deepEqual(
    parseSkillManifest(
      skillText(
        "review-pr",
        "Review a pull request when code review is requested.",
      ),
    ),
    {
      name: "review-pr",
      description:
        "Review a pull request when code review is requested.",
    },
  );
});

test("Agent Skill manifest rejects non-standard names", () => {
  for (const name of [
    "Review-PR",
    "-review",
    "review-",
    "review--pr",
    "a".repeat(65),
  ]) {
    assert.throws(
      () =>
        parseSkillManifest(
          skillText(
            name,
            "Review code when requested.",
          ),
        ),
      (error: unknown) =>
        error instanceof SkillError &&
        error.code === "invalid_skill",
      name,
    );
  }
});

test("Agent Skill manifest enforces description and instruction limits", () => {
  assert.throws(
    () =>
      parseSkillManifest(
        skillText(
          "review-pr",
          "x".repeat(1_025),
        ),
      ),
    (error: unknown) =>
      error instanceof SkillError &&
      error.code === "invalid_skill",
  );

  assert.throws(
    () =>
      parseSkillManifest(
        [
          "---",
          "name: review-pr",
          "description: Review code when requested.",
          "---",
          "",
        ].join("\n"),
      ),
    (error: unknown) =>
      error instanceof SkillError &&
      error.code === "invalid_skill",
  );
});

test("Agent Skill manifest rejects duplicate, mis-cased, or non-string required fields", () => {
  const invalid = [
    [
      "---",
      "name: review-pr",
      "name: other",
      "description: Review code.",
      "---",
      "",
      "Do the work.",
    ],
    [
      "---",
      "Name: review-pr",
      "description: Review code.",
      "---",
      "",
      "Do the work.",
    ],
    [
      "---",
      "name: 123",
      "description: Review code.",
      "---",
      "",
      "Do the work.",
    ],
    [
      "---",
      "name: review-pr",
      "description: true",
      "---",
      "",
      "Do the work.",
    ],
  ];

  for (const lines of invalid) {
    assert.throws(
      () =>
        parseSkillManifest(
          lines.join("\n"),
        ),
      (error: unknown) =>
        error instanceof SkillError &&
        error.code === "invalid_skill",
    );
  }
});

test("one installed Agent Skill tree cannot contain a nested second SKILL.md", async () => {
  const root = await mkdtemp(
    join(
      tmpdir(),
      "junius-skill-validation-",
    ),
  );

  try {
    await writeFile(
      join(root, "SKILL.md"),
      skillText(
        "root-skill",
        "Use the root skill when requested.",
      ),
      "utf8",
    );
    await mkdir(
      join(root, "nested"),
      { recursive: true },
    );
    await writeFile(
      join(
        root,
        "nested",
        "SKILL.md",
      ),
      skillText(
        "nested-skill",
        "Use the nested skill when requested.",
      ),
      "utf8",
    );

    await assert.rejects(
      assertSkillTreeSafe(root),
      (error: unknown) =>
        error instanceof SkillError &&
        error.code === "invalid_skill",
    );
  } finally {
    await rm(
      root,
      {
        recursive: true,
        force: true,
      },
    );
  }
});


test("skill reads canonicalize a junctioned skill root before containment checks", async () => {
  const root = await mkdtemp(
    join(
      tmpdir(),
      "junius-skill-junction-",
    ),
  );

  try {
    const realParent =
      join(root, "real");
    const realSkill =
      join(realParent, "junction-skill");
    const aliasParent =
      join(root, "alias");

    await mkdir(
      realSkill,
      { recursive: true },
    );
    await writeFile(
      join(realSkill, "SKILL.md"),
      skillText(
        "junction-skill",
        "Read through a junctioned parent.",
      ),
      "utf8",
    );
    await symlink(
      realParent,
      aliasParent,
      "junction",
    );

    const content =
      await readSkillTextFile(
        join(aliasParent, "junction-skill"),
        "SKILL.md",
      );
    assert.match(
      content,
      /junction-skill/u,
    );
  } finally {
    await rm(
      root,
      {
        recursive: true,
        force: true,
      },
    );
  }
});
