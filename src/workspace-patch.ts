import type {
  WorkspaceFilesService,
} from "./workspace-files.js";
import {
  runWorkspaceApply,
  type WorkspaceApplyResult,
} from "./workspace-apply.js";
import type {
  WorkspaceReadBatchOperation,
} from "./workspace-batch.js";
import {
  parseUnifiedPatch,
} from "./workspace-unified-patch.js";

export async function runWorkspacePatch(
  files:
    WorkspaceFilesService,
  workspace: string,
  patch: string,
  verify:
    readonly WorkspaceReadBatchOperation[] =
    [],
  agentsDigest?: string,
): Promise<WorkspaceApplyResult> {
  return runWorkspaceApply(
    files,
    workspace,
    parseUnifiedPatch(
      patch,
    ),
    verify,
    agentsDigest,
    "workspace_patch",
  );
}
