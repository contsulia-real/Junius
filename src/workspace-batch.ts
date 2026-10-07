import {
  WorkspaceFileError,
  WorkspaceFilesService,
  type ReadRequest,
} from "./workspace-files.js";

export const MAX_WORKSPACE_BATCH_OPERATIONS = 32;
export const WORKSPACE_BATCH_PARALLELISM = 8;
const MAX_RESULT_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export type WorkspaceReadBatchOperation =
  | {
      readonly id?: string;
      readonly op: "ls";
      readonly path?: string;
      readonly depth?: number;
    }
  | {
      readonly id?: string;
      readonly op: "read";
      readonly files: readonly ReadRequest[];
    }
  | {
      readonly id?: string;
      readonly op: "rg";
      readonly query: string;
      readonly path?: string;
      readonly globs?: readonly string[];
      readonly caseSensitive?: boolean;
      readonly fixedStrings?: boolean;
      readonly hidden?: boolean;
      readonly maxResults?: number;
    };

export interface WorkspaceReadBatchResult {
  readonly workspace: string;
  readonly durationMs: number;
  readonly results: readonly unknown[];
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function executeOperation(
  files: WorkspaceFilesService,
  workspace: string,
  operation: WorkspaceReadBatchOperation,
  index: number,
): Promise<Record<string, unknown>> {
  const startedAt = performance.now();

  try {
    let result: unknown;

    switch (operation.op) {
      case "ls": {
        const path =
          operation.path ?? ".";
        const depth =
          operation.depth ?? 1;
        const [
          entries,
          agentInstructions,
        ] =
          await Promise.all([
            files.ls(
              workspace,
              path,
              depth,
            ),
            files.agentInstructionsForScan(
              workspace,
              path,
              depth,
            ),
          ]);
        result = {
          entries,
          ...(agentInstructions
            .instructions
            .length === 0
            ? {}
            : {
                agentInstructions,
              }),
        };
        break;
      }

      case "read": {
        const [
          readFiles,
          agentInstructions,
        ] =
          await Promise.all([
            files.read(
              workspace,
              operation.files,
            ),
            files.agentInstructionsForPaths(
              workspace,
              operation.files.map(
                (file) =>
                  file.path,
              ),
            ),
          ]);
        result = {
          files: readFiles,
          ...(agentInstructions
            .instructions
            .length === 0
            ? {}
            : {
                agentInstructions,
              }),
        };
        break;
      }

      case "rg": {
        const path =
          operation.path ?? ".";
        const [
          matches,
          agentInstructions,
        ] =
          await Promise.all([
            files.rg(workspace, {
              query:
                operation.query,
              path:
                operation.path,
              globs:
                operation.globs,
              caseSensitive:
                operation.caseSensitive,
              fixedStrings:
                operation.fixedStrings,
              hidden:
                operation.hidden,
              maxResults:
                operation.maxResults,
            }),
            files.agentInstructionsForScan(
              workspace,
              path,
            ),
          ]);
        result = {
          query:
            operation.query,
          matches,
          ...(agentInstructions
            .instructions
            .length === 0
            ? {}
            : {
                agentInstructions,
              }),
        };
        break;
      }
    }

    const response = {
      index,
      ...(operation.id === undefined ? {} : { id: operation.id }),
      op: operation.op,
      ok: true,
      durationMs: Math.round(performance.now() - startedAt),
      ...result as Record<string, unknown>,
    };

    if (byteLength(response) > MAX_RESULT_BYTES) {
      return {
        index,
        ...(operation.id === undefined ? {} : { id: operation.id }),
        op: operation.op,
        ok: false,
        code: "batch_result_too_large",
        message:
          `Batch operation result exceeded ${MAX_RESULT_BYTES} bytes.`,
        durationMs: Math.round(performance.now() - startedAt),
      };
    }

    return response;
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      return {
        index,
        ...(operation.id === undefined ? {} : { id: operation.id }),
        op: operation.op,
        ok: false,
        code: error.code,
        message: error.message,
        durationMs: Math.round(performance.now() - startedAt),
      };
    }

    throw error;
  }
}

export async function runWorkspaceReadBatch(
  files: WorkspaceFilesService,
  workspace: string,
  operations: readonly WorkspaceReadBatchOperation[],
): Promise<WorkspaceReadBatchResult> {
  if (
    operations.length < 1 ||
    operations.length > MAX_WORKSPACE_BATCH_OPERATIONS
  ) {
    throw new Error(
      `workspace_batch accepts 1-${MAX_WORKSPACE_BATCH_OPERATIONS} operations.`,
    );
  }

  const startedAt = performance.now();
  const rawResults =
    new Array<Record<string, unknown>>(operations.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= operations.length) return;

      rawResults[index] = await executeOperation(
        files,
        workspace,
        operations[index]!,
        index,
      );
    }
  };

  await Promise.all(
    Array.from(
      {
        length: Math.min(
          WORKSPACE_BATCH_PARALLELISM,
          operations.length,
        ),
      },
      worker,
    ),
  );

  let usedBytes = 0;
  const results = rawResults.map((result) => {
    const resultBytes = byteLength(result);

    if (usedBytes + resultBytes <= MAX_TOTAL_BYTES) {
      usedBytes += resultBytes;
      return result;
    }

    const compact = {
      index: result.index,
      ...("id" in result ? { id: result.id } : {}),
      op: result.op,
      ok: false,
      code: "batch_output_budget_exceeded",
      message:
        `Batch response exceeded ${MAX_TOTAL_BYTES} bytes total.`,
    };
    usedBytes += byteLength(compact);
    return compact;
  });

  return {
    workspace,
    durationMs: Math.round(performance.now() - startedAt),
    results,
  };
}
