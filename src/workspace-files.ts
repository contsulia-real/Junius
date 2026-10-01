import type { WorkspaceManager } from "./workspace-manager.js";
import type { AuditStore } from "./audit-store.js";
import {
  WorkspaceFileError,
} from "./workspace-file-error.js";
import {
  getResolver,
} from "./workspace-path-resolver.js";
import {
  MAX_READ_FILES,
  listDirectory,
  readTextFile,
  type LsEntry,
  type ReadRequest,
  type ReadResult,
} from "./workspace-file-read.js";
import {
  runRg,
  type RgMatch,
} from "./workspace-rg.js";
import {
  agentsForPaths,
  agentsForScan,
  assertAgentsDigest,
  type WorkspaceAgentInstructions,
} from "./workspace-agents.js";
import {
  mutateWorkspace,
  mutationPaths,
  type WorkspaceMutation,
  type WorkspaceMutationResult,
} from "./workspace-mutation.js";

export {
  WorkspaceFileError,
  type WorkspaceFileErrorCode,
} from "./workspace-file-error.js";
export { WorkspacePathResolver } from "./workspace-path-resolver.js";
export {
  type LsEntry,
  type ReadRequest,
  type ReadResult,
} from "./workspace-file-read.js";
export {
  type WorkspaceMutation,
  type WorkspaceMutationResult,
} from "./workspace-mutation.js";

export class WorkspaceFilesService {
  constructor(
    private readonly manager: WorkspaceManager,
    private readonly protectedPaths: readonly string[] = [],
    private readonly audit?: AuditStore,
  ) {}

  async agentInstructionsForPaths(
    workspace: string,
    paths: readonly string[],
  ): Promise<WorkspaceAgentInstructions> {
    return agentsForPaths(
      getResolver(
        this.manager,
        workspace,
        this.protectedPaths,
      ),
      paths,
    );
  }

  async agentInstructionsForScan(
    workspace: string,
    path = ".",
    maxDepth?: number,
  ): Promise<WorkspaceAgentInstructions> {
    return agentsForScan(
      getResolver(
        this.manager,
        workspace,
        this.protectedPaths,
      ),
      path,
      maxDepth,
    );
  }

  async ls(
    workspace: string,
    path = ".",
    depth = 1,
  ): Promise<readonly LsEntry[]> {
    return listDirectory(
      getResolver(
        this.manager,
        workspace,
        this.protectedPaths,
      ),
      path,
      depth,
    );
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

    const resolver = getResolver(
      this.manager,
      workspace,
      this.protectedPaths,
    );
    return Promise.all(files.map((file) => readTextFile(resolver, file)));
  }

  async mutate(
    workspace: string,
    mutations:
      readonly WorkspaceMutation[],
    auditAction:
      | "write_file"
      | "apply_patch"
      | "delete_file"
      | "move_file"
      | "copy_file"
      | "mkdir"
      | "workspace_mutate",
    agentsDigest?: string,
  ): Promise<
    readonly WorkspaceMutationResult[]
  > {
    const startedAt =
      performance.now();
    const requestedPaths =
      mutationPaths(
        mutations,
      );

    try {
      const resolver =
        getResolver(
          this.manager,
          workspace,
          this.protectedPaths,
        );
      const agentInstructions =
        await agentsForPaths(
          resolver,
          requestedPaths,
        );
      assertAgentsDigest(
        agentInstructions,
        agentsDigest,
      );

      const results =
        await mutateWorkspace(
          resolver,
          mutations,
        );

      this.audit?.record({
        category: "workspace",
        action: auditAction,
        status: "succeeded",
        workspace,
        summary:
          results.length +
          " mutation(s) applied.",
        durationMs:
          performance.now() -
          startedAt,
        metadata: {
          paths:
            requestedPaths,
          operations:
            results.map(
              (result) =>
                result.kind,
            ),
        },
      });

      return results;
    } catch (error) {
      this.audit?.record({
        category: "workspace",
        action: auditAction,
        status: "failed",
        workspace,
        summary:
          error instanceof Error
            ? error.message
            : String(error),
        durationMs:
          performance.now() -
          startedAt,
        metadata: {
          paths:
            requestedPaths,
        },
      });
      throw error;
    }
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

    return runRg(
      getResolver(
        this.manager,
        workspace,
        this.protectedPaths,
      ),
      {
      query: options.query,
      path: options.path ?? ".",
      globs: options.globs ?? [],
      caseSensitive: options.caseSensitive ?? true,
      fixedStrings: options.fixedStrings ?? false,
      hidden: options.hidden ?? false,
        maxResults,
      },
    );
  }
}

