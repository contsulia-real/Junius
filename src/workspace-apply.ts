import {
  WorkspaceFilesService,
  type WriteRequest,
  type WriteResult,
} from "./workspace-files.js";
import {
  runWorkspaceReadBatch,
  type WorkspaceReadBatchOperation,
  type WorkspaceReadBatchResult,
} from "./workspace-batch.js";

export interface WorkspaceApplyResult {
  readonly workspace: string;
  readonly writes: readonly WriteResult[];
  readonly writeDurationMs: number;
  readonly verification?: WorkspaceReadBatchResult;
  readonly durationMs: number;
}

export async function runWorkspaceApply(
  files: WorkspaceFilesService,
  workspace: string,
  writes: readonly WriteRequest[],
  verify: readonly WorkspaceReadBatchOperation[] = [],
): Promise<WorkspaceApplyResult> {
  const startedAt = performance.now();

  const writeStartedAt = performance.now();
  const writeResults = await files.write(workspace, writes);
  const writeDurationMs = Math.round(
    performance.now() - writeStartedAt,
  );

  const verification =
    verify.length === 0
      ? undefined
      : await runWorkspaceReadBatch(
          files,
          workspace,
          verify,
        );

  return {
    workspace,
    writes: writeResults,
    writeDurationMs,
    ...(verification === undefined
      ? {}
      : { verification }),
    durationMs: Math.round(performance.now() - startedAt),
  };
}
