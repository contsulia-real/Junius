import {
  lstat,
  readdir,
  realpath,
} from "node:fs/promises";
import {
  join,
  resolve,
} from "node:path";
import {
  SkillError,
} from "./skill-errors.js";
import {
  SKILL_FILE,
  pathExists,
  pathInside,
  readSkillManifest,
  readSkillTextFile,
  sameSkillName,
} from "./skill-files.js";
import type {
  InvalidSkill,
  LocatedSkill,
  SkillListResult,
  SkillReadRequest,
  SkillReadResult,
  SkillScope,
  SkillSummary,
} from "./skill-types.js";
import type {
  WorkspaceRegistryService,
} from "./workspace-registry.js";

function errorMessage(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function skillKey(
  name: string,
): string {
  return process.platform ===
    "win32"
    ? name.toLowerCase()
    : name;
}

export class SkillCatalog {
  constructor(
    private readonly workspaces:
      WorkspaceRegistryService,
    readonly globalSkillsRoot:
      string,
  ) {}

  workspaceRoot(
    workspace: string,
  ): string {
    const match =
      this.workspaces
        .list()
        .find(
          (item) =>
            item.id ===
            workspace,
        );

    if (
      match === undefined
    ) {
      throw new SkillError(
        "workspace_not_registered",
        `Workspace is not registered: ${workspace}`,
      );
    }

    return match.rootPath;
  }

  scopeRoot(
    scope: SkillScope,
    workspace?: string,
  ): string {
    if (
      scope === "global"
    ) {
      return this
        .globalSkillsRoot;
    }

    if (!workspace) {
      throw new SkillError(
        "workspace_not_registered",
        "Workspace scope requires a workspace ID.",
      );
    }

    return join(
      this.workspaceRoot(
        workspace,
      ),
      ".agents",
      "skills",
    );
  }

  async assertWorkspaceStorageRoot(
    workspace: string,
    root: string,
  ): Promise<void> {
    const workspaceRoot =
      await realpath(
        this.workspaceRoot(
          workspace,
        ),
      );

    let current =
      root;

    for (;;) {
      try {
        await lstat(current);
        break;
      } catch (error) {
        if (
          !(
            typeof error ===
              "object" &&
            error !== null &&
            "code" in error &&
            error.code ===
              "ENOENT"
          )
        ) {
          throw error;
        }
      }

      const parent =
        resolve(
          current,
          "..",
        );

      if (
        parent === current
      ) {
        throw new SkillError(
          "skill_install_failed",
          `No existing ancestor for Workspace skill root: ${root}`,
        );
      }

      current = parent;
    }

    const canonical =
      await realpath(
        current,
      );

    if (
      !pathInside(
        workspaceRoot,
        canonical,
      )
    ) {
      throw new SkillError(
        "skill_install_failed",
        "Workspace skill storage resolves outside the Workspace.",
      );
    }
  }

  async #scanScope(
    scope: SkillScope,
    workspace?: string,
  ): Promise<{
    readonly skills:
      readonly LocatedSkill[];
    readonly invalid:
      readonly InvalidSkill[];
  }> {
    const root =
      this.scopeRoot(
        scope,
        workspace,
      );

    if (
      !(await pathExists(root))
    ) {
      return {
        skills: [],
        invalid: [],
      };
    }

    if (
      scope === "workspace" &&
      workspace
    ) {
      await this
        .assertWorkspaceStorageRoot(
          workspace,
          root,
        );
    }

    const entries =
      await readdir(
        root,
        {
          withFileTypes:
            true,
        },
      );
    const skills:
      LocatedSkill[] = [];
    const invalid:
      InvalidSkill[] = [];

    for (
      const entry of entries
    ) {
      if (
        !entry.isDirectory()
      ) {
        continue;
      }

      const skillRoot =
        join(
          root,
          entry.name,
        );

      try {
        const manifest =
          await readSkillManifest(
            skillRoot,
          );

        if (
          !sameSkillName(
            manifest.name,
            entry.name,
          )
        ) {
          throw new SkillError(
            "invalid_skill",
            `Skill directory name ${entry.name} does not match manifest name ${manifest.name}.`,
          );
        }

        skills.push({
          ...manifest,
          scope,
          rootPath:
            skillRoot,
        });
      } catch (error) {
        invalid.push({
          scope,
          path:
            skillRoot,
          message:
            errorMessage(
              error,
            ),
        });
      }
    }

    return {
      skills,
      invalid,
    };
  }

  async list(
    workspace?: string,
  ): Promise<SkillListResult> {
    const global =
      await this.#scanScope(
        "global",
      );
    const local =
      workspace === undefined
        ? {
            skills:
              [] as readonly LocatedSkill[],
            invalid:
              [] as readonly InvalidSkill[],
          }
        : await this.#scanScope(
            "workspace",
            workspace,
          );

    const workspaceNames =
      new Set(
        local.skills.map(
          (skill) =>
            skillKey(
              skill.name,
            ),
        ),
      );
    const globalNames =
      new Set(
        global.skills.map(
          (skill) =>
            skillKey(
              skill.name,
            ),
        ),
      );

    const summaries:
      SkillSummary[] = [
        ...global.skills.map(
          (skill) => {
            const shadowed =
              workspaceNames.has(
                skillKey(
                  skill.name,
                ),
              );

            return {
              name:
                skill.name,
              description:
                skill.description,
              scope:
                "global" as const,
              effective:
                !shadowed,
              path:
                skill.rootPath,
              ...(shadowed
                ? {
                    shadowedBy:
                      "workspace" as const,
                  }
                : {}),
            };
          },
        ),
        ...local.skills.map(
          (skill) => {
            const shadows =
              globalNames.has(
                skillKey(
                  skill.name,
                ),
              );

            return {
              name:
                skill.name,
              description:
                skill.description,
              scope:
                "workspace" as const,
              effective:
                true,
              path:
                skill.rootPath,
              ...(shadows
                ? {
                    shadows:
                      "global" as const,
                  }
                : {}),
            };
          },
        ),
      ];

    summaries.sort(
      (left, right) =>
        left.name.localeCompare(
          right.name,
        ) ||
        left.scope.localeCompare(
          right.scope,
        ),
    );

    return {
      skills: summaries,
      invalid: [
        ...global.invalid,
        ...local.invalid,
      ],
    };
  }

  async find(
    name: string,
    scope: SkillScope,
    workspace?: string,
  ): Promise<
    LocatedSkill | undefined
  > {
    const scanned =
      await this.#scanScope(
        scope,
        workspace,
      );

    return scanned.skills.find(
      (skill) =>
        sameSkillName(
          skill.name,
          name,
        ),
    );
  }

  async effective(
    name: string,
    workspace?: string,
  ): Promise<
    LocatedSkill | undefined
  > {
    if (
      workspace !==
      undefined
    ) {
      const local =
        await this.find(
          name,
          "workspace",
          workspace,
        );

      if (
        local !== undefined
      ) {
        return local;
      }
    }

    return this.find(
      name,
      "global",
    );
  }

  async read(
    request:
      SkillReadRequest,
  ): Promise<SkillReadResult> {
    const scope =
      request.scope ??
      "effective";

    const located =
      scope === "effective"
        ? await this.effective(
            request.name,
            request.workspace,
          )
        : await this.find(
            request.name,
            scope,
            request.workspace,
          );

    if (
      located === undefined
    ) {
      throw new SkillError(
        "skill_not_found",
        `Skill was not found: ${request.name}`,
      );
    }

    const path =
      request.path ??
      SKILL_FILE;

    return {
      name:
        located.name,
      description:
        located.description,
      scope:
        located.scope,
      rootPath:
        located.rootPath,
      path,
      content:
        await readSkillTextFile(
          located.rootPath,
          path,
        ),
    };
  }
}
