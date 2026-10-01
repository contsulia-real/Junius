import type { WorkspaceFilesService, WorkspaceMutation, WorkspaceMutationResult } from "./workspace-files.js";
import { runWorkspaceReadBatch, type WorkspaceReadBatchOperation, type WorkspaceReadBatchResult } from "./workspace-batch.js";

export interface WorkspaceMutateResult {
  readonly workspace: string;
  readonly mutations: readonly WorkspaceMutationResult[];
  readonly mutationDurationMs: number;
  readonly verification?: WorkspaceReadBatchResult;
  readonly durationMs: number;
}

export async function runWorkspaceMutate(
  files: WorkspaceFilesService,
  workspace: string,
  mutations: readonly WorkspaceMutation[],
  verify: readonly WorkspaceReadBatchOperation[] = [],
  agentsDigest?: string,
): Promise<WorkspaceMutateResult> {
  const startedAt = performance.now();
  const mutationStartedAt = performance.now();
  const results = await files.mutate(
    workspace,
    mutations,
    "workspace_mutate",
    agentsDigest,
  );
  const mutationDurationMs = Math.round(performance.now() - mutationStartedAt);
  const verification = verify.length === 0
    ? undefined
    : await runWorkspaceReadBatch(files, workspace, verify);
  return {
    workspace,
    mutations: results,
    mutationDurationMs,
    ...(verification === undefined ? {} : { verification }),
    durationMs: Math.round(performance.now() - startedAt),
  };
}
