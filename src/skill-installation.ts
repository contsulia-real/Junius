import {
  randomUUID,
} from "node:crypto";
import {
  mkdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  dirname,
  join,
  relative,
  resolve,
} from "node:path";
import {
  SkillError,
} from "./skill-errors.js";
import {
  assertSkillTreeSafe,
  collectSkillCandidates,
  copySkillTree,
  pathInside,
  pathExists,
  readSkillManifest,
  safeSkillRelativePath,
  sameSkillName,
} from "./skill-files.js";
import type {
  CandidateSkill,
  LocatedSkill,
  SkillInstallResult,
  SkillScope,
} from "./skill-types.js";

export async function resolveSkillCandidate(
  sourceRoot: string,
  subpath?: string,
): Promise<CandidateSkill> {
  let root =
    sourceRoot;

  if (
    subpath !== undefined
  ) {
    const relativeSubpath =
      safeSkillRelativePath(
        subpath,
        "invalid_source",
      );
    root =
      resolve(
        sourceRoot,
        relativeSubpath,
      );

    const canonicalSource =
      await realpath(
        sourceRoot,
      );

    let canonicalRoot:
      string;
    try {
      canonicalRoot =
        await realpath(root);
    } catch {
      throw new SkillError(
        "invalid_source",
        `Skill source subpath does not exist: ${subpath}`,
      );
    }

    if (
      !pathInside(
        canonicalSource,
        canonicalRoot,
      )
    ) {
      throw new SkillError(
        "invalid_source",
        `Skill source subpath escapes the source: ${subpath}`,
      );
    }

    root =
      canonicalRoot;
  }

  const candidates =
    await collectSkillCandidates(
      root,
    );

  if (
    candidates.length === 0
  ) {
    throw new SkillError(
      "invalid_source",
      "No SKILL.md was found in the skill source.",
    );
  }

  if (
    candidates.length > 1
  ) {
    throw new SkillError(
      "multiple_skills_found",
      "The source contains multiple skills; specify a subpath instead of guessing.",
      {
        candidates:
          candidates.map(
            (candidate) =>
              relative(
                sourceRoot,
                candidate
                  .rootPath,
              )
                .replaceAll(
                  "\\",
                  "/",
                ) ||
              ".",
          ),
      },
    );
  }

  const candidate =
    candidates[0];

  if (
    candidate === undefined
  ) {
    throw new SkillError(
      "invalid_source",
      "No skill candidate was resolved.",
    );
  }

  await assertSkillTreeSafe(
    candidate.rootPath,
  );

  return candidate;
}

export async function installSkillDirectory(
  candidate:
    CandidateSkill,
  scopeRoot: string,
  scope: SkillScope,
  source: string,
  replaceExisting: boolean,
): Promise<SkillInstallResult> {
  await mkdir(
    scopeRoot,
    {
      recursive: true,
    },
  );

  const destination =
    join(
      scopeRoot,
      candidate.name,
    );
  const existing =
    await pathExists(
      destination,
    );

  if (
    existing &&
    !replaceExisting
  ) {
    throw new SkillError(
      "skill_already_exists",
      `Skill already exists in ${scope} scope: ${candidate.name}`,
    );
  }

  const transactionRoot =
    dirname(
      scopeRoot,
    );
  const stage =
    join(
      transactionRoot,
      `.junius-skill-${randomUUID()}.stage`,
    );
  const backup =
    join(
      transactionRoot,
      `.junius-skill-${randomUUID()}.backup`,
    );

  let staged = false;
  let backedUp = false;
  let installed = false;

  try {
    await copySkillTree(
      candidate.rootPath,
      stage,
    );
    staged = true;

    const stagedManifest =
      await readSkillManifest(
        stage,
      );

    if (
      !sameSkillName(
        stagedManifest.name,
        candidate.name,
      )
    ) {
      throw new SkillError(
        "invalid_skill",
        "Staged skill manifest changed during installation.",
      );
    }

    await assertSkillTreeSafe(
      stage,
    );

    if (existing) {
      await rename(
        destination,
        backup,
      );
      backedUp = true;
    }

    await rename(
      stage,
      destination,
    );
    staged = false;
    installed = true;

    if (backedUp) {
      await rm(
        backup,
        {
          recursive: true,
          force: true,
        },
      );
      backedUp = false;
    }
  } catch (error) {
    if (installed) {
      await rm(
        destination,
        {
          recursive: true,
          force: true,
        },
      ).catch(
        () => undefined,
      );
    }

    if (backedUp) {
      await rename(
        backup,
        destination,
      ).catch(
        () => undefined,
      );
    }

    if (staged) {
      await rm(
        stage,
        {
          recursive: true,
          force: true,
        },
      ).catch(
        () => undefined,
      );
    }

    throw error;
  }

  return {
    name:
      candidate.name,
    description:
      candidate.description,
    scope,
    path:
      destination,
    source,
    replaced:
      existing,
  };
}

export async function removeSkillDirectory(
  located:
    LocatedSkill,
): Promise<void> {
  const scopeRoot =
    resolve(
      located.rootPath,
      "..",
    );
  const backup =
    join(
      dirname(scopeRoot),
      `.junius-skill-${randomUUID()}.remove`,
    );

  await rename(
    located.rootPath,
    backup,
  );

  try {
    await rm(
      backup,
      {
        recursive: true,
        force: true,
      },
    );
  } catch (error) {
    await rename(
      backup,
      located.rootPath,
    ).catch(
      () => undefined,
    );
    throw error;
  }
}
