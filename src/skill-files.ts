import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  SkillError,
} from "./skill-errors.js";
import {
  decodeSkillText,
  parseSkillManifest,
  type SkillManifest,
} from "./skill-frontmatter.js";
import type {
  CandidateSkill,
} from "./skill-types.js";

export const SKILL_FILE =
  "SKILL.md";
export const MAX_SKILL_FILE_BYTES =
  2 * 1024 * 1024;
export const MAX_SKILL_TREE_FILES =
  4_096;
export const MAX_SKILL_TREE_BYTES =
  128 * 1024 * 1024;

export function sameSkillName(
  left: string,
  right: string,
): boolean {
  return process.platform ===
    "win32"
    ? left.localeCompare(
        right,
        undefined,
        {
          sensitivity:
            "accent",
        },
      ) === 0
    : left === right;
}

export function pathInside(
  root: string,
  candidate: string,
): boolean {
  const rel =
    relative(
      root,
      candidate,
    );
  return (
    rel === "" ||
    (
      rel !== ".." &&
      !rel.startsWith(
        `..${sep}`,
      ) &&
      !isAbsolute(rel)
    )
  );
}

export function safeSkillRelativePath(
  path: string,
  code:
    | "path_outside_skill"
    | "invalid_source",
): string {
  if (
    path.includes("\0") ||
    isAbsolute(path)
  ) {
    throw new SkillError(
      code,
      `Invalid relative path: ${path}`,
    );
  }

  const segments =
    path
      .replaceAll(
        "\\",
        "/",
      )
      .split("/")
      .filter(Boolean);

  if (
    segments.some(
      (segment) =>
        segment === "..",
    )
  ) {
    throw new SkillError(
      code,
      `Path traversal is not allowed: ${path}`,
    );
  }

  return segments.join("/");
}

export async function pathExists(
  path: string,
): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error ===
        "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

export async function readSkillManifest(
  rootPath: string,
): Promise<SkillManifest> {
  const manifestPath =
    join(
      rootPath,
      SKILL_FILE,
    );

  let content:
    Buffer;

  try {
    const info =
      await lstat(
        manifestPath,
      );

    if (
      !info.isFile() ||
      info.isSymbolicLink()
    ) {
      throw new SkillError(
        "invalid_skill",
        `${SKILL_FILE} must be a regular file: ${rootPath}`,
      );
    }

    if (
      info.size >
      MAX_SKILL_FILE_BYTES
    ) {
      throw new SkillError(
        "invalid_skill",
        `${SKILL_FILE} exceeds ${MAX_SKILL_FILE_BYTES} bytes: ${rootPath}`,
      );
    }

    content =
      await readFile(
        manifestPath,
      );
  } catch (error) {
    if (
      error instanceof
      SkillError
    ) {
      throw error;
    }

    if (
      typeof error ===
        "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new SkillError(
        "invalid_skill",
        `Skill directory does not contain ${SKILL_FILE}: ${rootPath}`,
      );
    }

    throw error;
  }

  return parseSkillManifest(
    decodeSkillText(
      content,
      manifestPath,
    ),
  );
}

export async function assertSkillTreeSafe(
  rootPath: string,
): Promise<{
  readonly fileCount:
    number;
  readonly bytes:
    number;
}> {
  let fileCount = 0;
  let bytes = 0;
  let manifestCount = 0;

  async function walk(
    directory: string,
  ): Promise<void> {
    const entries =
      await readdir(
        directory,
        {
          withFileTypes:
            true,
        },
      );

    for (
      const entry of entries
    ) {
      const path =
        join(
          directory,
          entry.name,
        );
      const info =
        await lstat(path);

      if (
        info.isSymbolicLink()
      ) {
        throw new SkillError(
          "invalid_skill",
          `Skill trees may not contain symbolic links or junction aliases: ${path}`,
        );
      }

      if (
        info.isDirectory()
      ) {
        await walk(path);
        continue;
      }

      if (!info.isFile()) {
        throw new SkillError(
          "invalid_skill",
          `Skill trees may contain only regular files and directories: ${path}`,
        );
      }

      fileCount += 1;
      bytes += info.size;

      if (
        entry.name.toLowerCase() ===
        "skill.md"
      ) {
        manifestCount += 1;
        if (
          resolve(directory) !==
          resolve(rootPath)
        ) {
          throw new SkillError(
            "invalid_skill",
            `A skill may not contain a nested SKILL.md: ${path}`,
          );
        }
      }

      if (
        fileCount >
        MAX_SKILL_TREE_FILES
      ) {
        throw new SkillError(
          "invalid_skill",
          `Skill contains more than ${MAX_SKILL_TREE_FILES} files.`,
        );
      }

      if (
        bytes >
        MAX_SKILL_TREE_BYTES
      ) {
        throw new SkillError(
          "invalid_skill",
          `Skill contents exceed ${MAX_SKILL_TREE_BYTES} bytes.`,
        );
      }
    }
  }

  await walk(rootPath);

  if (manifestCount !== 1) {
    throw new SkillError(
      "invalid_skill",
      `A skill must contain exactly one SKILL.md; found ${manifestCount}.`,
    );
  }

  return {
    fileCount,
    bytes,
  };
}

export async function copySkillTree(
  source: string,
  destination: string,
): Promise<void> {
  await mkdir(
    destination,
    {
      recursive: true,
    },
  );

  const entries =
    await readdir(
      source,
      {
        withFileTypes:
          true,
      },
    );

  for (
    const entry of entries
  ) {
    const from =
      join(
        source,
        entry.name,
      );
    const to =
      join(
        destination,
        entry.name,
      );
    const info =
      await lstat(from);

    if (
      info.isSymbolicLink()
    ) {
      throw new SkillError(
        "invalid_skill",
        `Skill trees may not contain symbolic links or junction aliases: ${from}`,
      );
    }

    if (
      info.isDirectory()
    ) {
      await copySkillTree(
        from,
        to,
      );
      continue;
    }

    if (!info.isFile()) {
      throw new SkillError(
        "invalid_skill",
        `Skill trees may contain only regular files and directories: ${from}`,
      );
    }

    await copyFile(
      from,
      to,
    );
  }
}

export async function collectSkillCandidates(
  rootPath: string,
): Promise<
  readonly CandidateSkill[]
> {
  const direct =
    join(
      rootPath,
      SKILL_FILE,
    );

  if (
    await pathExists(
      direct,
    )
  ) {
    return [
      {
        rootPath,
        ...await readSkillManifest(
          rootPath,
        ),
      },
    ];
  }

  const candidates:
    CandidateSkill[] = [];
  let visited = 0;

  async function walk(
    directory: string,
  ): Promise<void> {
    const entries =
      await readdir(
        directory,
        {
          withFileTypes:
            true,
        },
      );

    for (
      const entry of entries
    ) {
      visited += 1;

      if (
        visited >
        MAX_SKILL_TREE_FILES
      ) {
        throw new SkillError(
          "invalid_source",
          `Skill source contains more than ${MAX_SKILL_TREE_FILES} entries while searching for ${SKILL_FILE}.`,
        );
      }

      const path =
        join(
          directory,
          entry.name,
        );
      const info =
        await lstat(path);

      if (
        info.isSymbolicLink()
      ) {
        throw new SkillError(
          "invalid_source",
          `Skill source contains a symbolic link or junction alias: ${path}`,
        );
      }

      if (
        !info.isDirectory()
      ) {
        continue;
      }

      const manifest =
        join(
          path,
          SKILL_FILE,
        );

      if (
        await pathExists(
          manifest,
        )
      ) {
        candidates.push({
          rootPath:
            path,
          ...await readSkillManifest(
            path,
          ),
        });
        continue;
      }

      await walk(path);
    }
  }

  await walk(rootPath);
  return candidates;
}

export async function readSkillTextFile(
  rootPath: string,
  path: string,
): Promise<string> {
  const requested =
    safeSkillRelativePath(
      path,
      "path_outside_skill",
    );
  const canonicalRoot =
    await realpath(
      rootPath,
    );
  const target =
    resolve(
      rootPath,
      requested,
    );

  let canonicalTarget:
    string;
  try {
    canonicalTarget =
      await realpath(
        target,
      );
  } catch {
    throw new SkillError(
      "skill_not_found",
      `Skill file was not found: ${requested}`,
    );
  }

  if (
    !pathInside(
      canonicalRoot,
      canonicalTarget,
    )
  ) {
    throw new SkillError(
      "path_outside_skill",
      requested,
    );
  }

  const info =
    await lstat(
      canonicalTarget,
    );

  if (!info.isFile()) {
    throw new SkillError(
      "invalid_skill",
      `Skill path is not a regular file: ${requested}`,
    );
  }

  if (
    info.size >
    MAX_SKILL_FILE_BYTES
  ) {
    throw new SkillError(
      "invalid_skill",
      `Skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes: ${requested}`,
    );
  }

  return decodeSkillText(
    await readFile(
      canonicalTarget,
    ),
    canonicalTarget,
  );
}
