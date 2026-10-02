import {
  mkdir,
} from "node:fs/promises";
import {
  join,
  resolve,
} from "node:path";
import type {
  AuditStore,
} from "./audit-store.js";
import {
  SkillCatalog,
} from "./skill-catalog.js";
import {
  SkillError,
  type SkillErrorCode,
} from "./skill-errors.js";
import {
  SKILL_FILE,
} from "./skill-files.js";
import {
  installSkillDirectory,
  removeSkillDirectory,
  resolveSkillCandidate,
} from "./skill-installation.js";
import {
  materializeSkillSource,
  type SkillSourceOptions,
} from "./skill-source.js";
import type {
  SkillInstallRequest,
  SkillInstallResult,
  SkillListResult,
  SkillReadRequest,
  SkillReadResult,
  SkillRemoveRequest,
  SkillRemoveResult,
  SkillServiceOptions,
  SkillSummary,
} from "./skill-types.js";
import {
  assertAgentsDigest,
} from "./workspace-agents.js";
import {
  WorkspaceFileError,
  type WorkspaceFilesService,
} from "./workspace-files.js";
import type {
  WorkspaceRegistryService,
} from "./workspace-registry.js";

export {
  SkillError,
  type SkillErrorCode,
};
export type {
  InvalidSkill,
  SkillInstallRequest,
  SkillInstallResult,
  SkillListResult,
  SkillReadRequest,
  SkillReadResult,
  SkillRemoveRequest,
  SkillRemoveResult,
  SkillScope,
  SkillServiceOptions,
  SkillSummary,
} from "./skill-types.js";

function errorMessage(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function auditFailureCode(
  error: unknown,
  fallback: string,
): string {
  if (
    error instanceof SkillError ||
    error instanceof WorkspaceFileError
  ) {
    return error.code;
  }

  return fallback;
}

function auditSourceSubject(
  source: string,
): string {
  return (
    source.startsWith("http://") ||
    source.startsWith("https://")
  )
    ? "remote skill source"
    : "local skill source";
}

function samePath(
  left: string,
  right: string,
): boolean {
  return process.platform === "win32"
    ? left.localeCompare(
        right,
        undefined,
        { sensitivity: "accent" },
      ) === 0
    : left === right;
}

function summary(
  skill: {
    readonly name: string;
    readonly description: string;
    readonly scope: "global" | "workspace";
    readonly rootPath: string;
  },
  effective: boolean,
): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    effective,
    path: skill.rootPath,
  };
}

export class SkillService {
  readonly #catalog: SkillCatalog;
  readonly #sourceOptions:
    SkillSourceOptions;

  constructor(
    workspaces:
      WorkspaceRegistryService,
    private readonly files:
      WorkspaceFilesService,
    options:
      SkillServiceOptions = {},
    private readonly audit?:
      AuditStore,
  ) {
    const environment =
      options.environment ??
      process.env;
    const userProfile =
      environment.USERPROFILE ??
      environment.HOME;

    if (
      options.globalSkillsRoot ===
        undefined &&
      !userProfile
    ) {
      throw new Error(
        "USERPROFILE is required to resolve global Agent Skills.",
      );
    }

    this.#catalog =
      new SkillCatalog(
        workspaces,
        resolve(
          options.globalSkillsRoot ??
            join(
              userProfile as string,
              ".agents",
              "skills",
            ),
        ),
      );

    this.#sourceOptions = {
      ...(options.fetchImpl === undefined
        ? {}
        : {
            fetchImpl:
              options.fetchImpl,
          }),
      environment,
      ...(options.tempRoot === undefined
        ? {}
        : {
            tempRoot:
              options.tempRoot,
          }),
    };
  }

  list(
    workspace?: string,
  ): Promise<SkillListResult> {
    return this.#catalog.list(
      workspace,
    );
  }

  read(
    request:
      SkillReadRequest,
  ): Promise<SkillReadResult> {
    return this.#catalog.read(
      request,
    );
  }

  async #ackWorkspaceMutation(
    workspace: string,
    skillName: string,
    agentsDigest?: string,
  ): Promise<void> {
    const instructions =
      await this.files
        .agentInstructionsForPaths(
          workspace,
          [
            `.agents/skills/${skillName}/${SKILL_FILE}`,
          ],
        );

    assertAgentsDigest(
      instructions,
      agentsDigest,
    );
  }

  async install(
    request:
      SkillInstallRequest,
  ): Promise<SkillInstallResult> {
    const startedAt =
      performance.now();
    let materialized:
      Awaited<
        ReturnType<
          typeof materializeSkillSource
        >
      > | undefined;

    try {
      const sourceBase =
        request.workspace === undefined
          ? undefined
          : this.#catalog.workspaceRoot(
              request.workspace,
            );

      materialized =
        await materializeSkillSource(
          request.source,
          this.#sourceOptions,
          sourceBase,
          request.subpath,
        );

      const candidate =
        await resolveSkillCandidate(
          materialized.rootPath,
          materialized.suggestedSubpath,
        );

      if (
        request.scope ===
        "workspace"
      ) {
        if (!request.workspace) {
          throw new SkillError(
            "workspace_not_registered",
            "Workspace scope requires a workspace ID.",
          );
        }

        await this
          .#ackWorkspaceMutation(
            request.workspace,
            candidate.name,
            request.agentsDigest,
          );
      }

      const scopeRoot =
        this.#catalog.scopeRoot(
          request.scope,
          request.workspace,
        );

      if (
        request.scope ===
          "workspace" &&
        request.workspace
      ) {
        await this.#catalog
          .assertWorkspaceStorageRoot(
            request.workspace,
            scopeRoot,
          );
      }

      await mkdir(
        scopeRoot,
        { recursive: true },
      );

      if (
        request.scope ===
          "workspace" &&
        request.workspace
      ) {
        await this.#catalog
          .assertWorkspaceStorageRoot(
            request.workspace,
            scopeRoot,
          );
      }

      const result =
        await installSkillDirectory(
          candidate,
          scopeRoot,
          request.scope,
          request.source,
          request.replace === true,
        );

      this.audit?.record({
        category: "configuration",
        action: "skill_install",
        status: "succeeded",
        workspace:
          request.workspace,
        subject:
          result.name,
        summary:
          `Installed ${request.scope} Agent Skill.`,
        durationMs:
          performance.now() -
          startedAt,
        metadata: {
          scope:
            request.scope,
          replaced:
            result.replaced,
          remote:
            /^https?:\/\//iu.test(
              request.source,
            ),
        },
      });

      return result;
    } catch (error) {
      this.audit?.record({
        category: "configuration",
        action: "skill_install",
        status: "failed",
        workspace:
          request.workspace,
        subject:
          auditSourceSubject(
            request.source,
          ),
        summary:
          auditFailureCode(
            error,
            "skill_install_failed",
          ),
        durationMs:
          performance.now() -
          startedAt,
      });

      if (
        error instanceof SkillError ||
        error instanceof WorkspaceFileError
      ) {
        throw error;
      }

      throw new SkillError(
        "skill_install_failed",
        errorMessage(error),
      );
    } finally {
      if (
        materialized !== undefined
      ) {
        await materialized
          .cleanup()
          .catch(
            () => undefined,
          );
      }
    }
  }

  async remove(
    request:
      SkillRemoveRequest,
  ): Promise<SkillRemoveResult> {
    const startedAt =
      performance.now();

    try {
      const located =
        await this.#catalog.find(
          request.name,
          request.scope,
          request.workspace,
        );

      if (
        located === undefined
      ) {
        throw new SkillError(
          "skill_not_found",
          `Skill was not found in ${request.scope} scope: ${request.name}`,
        );
      }

      if (
        request.scope ===
        "workspace"
      ) {
        if (!request.workspace) {
          throw new SkillError(
            "workspace_not_registered",
            "Workspace scope requires a workspace ID.",
          );
        }

        await this
          .#ackWorkspaceMutation(
            request.workspace,
            located.name,
            request.agentsDigest,
          );

        await this.#catalog
          .assertWorkspaceStorageRoot(
            request.workspace,
            this.#catalog.scopeRoot(
              "workspace",
              request.workspace,
            ),
          );
      }

      const effectiveBefore =
        await this.#catalog.effective(
          located.name,
          request.workspace,
        );
      const wasEffective =
        effectiveBefore !== undefined &&
        samePath(
          effectiveBefore.rootPath,
          located.rootPath,
        );

      await removeSkillDirectory(
        located,
      );

      const effectiveAfter =
        await this.#catalog.effective(
          located.name,
          request.workspace,
        );

      const result:
        SkillRemoveResult = {
          removed:
            summary(
              located,
              wasEffective,
            ),
          ...(effectiveAfter === undefined
            ? {}
            : {
                effectiveAfter:
                  summary(
                    effectiveAfter,
                    true,
                  ),
              }),
        };

      this.audit?.record({
        category: "configuration",
        action: "skill_remove",
        status: "succeeded",
        workspace:
          request.workspace,
        subject:
          located.name,
        summary:
          `Removed ${request.scope} Agent Skill.`,
        durationMs:
          performance.now() -
          startedAt,
        metadata: {
          scope:
            request.scope,
        },
      });

      return result;
    } catch (error) {
      this.audit?.record({
        category: "configuration",
        action: "skill_remove",
        status: "failed",
        workspace:
          request.workspace,
        subject:
          request.name,
        summary:
          auditFailureCode(
            error,
            "skill_remove_failed",
          ),
        durationMs:
          performance.now() -
          startedAt,
      });

      if (
        error instanceof SkillError ||
        error instanceof WorkspaceFileError
      ) {
        throw error;
      }

      throw new SkillError(
        "skill_remove_failed",
        errorMessage(error),
      );
    }
  }
}
