import type {
  RunCommandResult,
  RunCommandService,
} from "./run-command.js";

export type CommandBatchMode =
  | "parallel"
  | "serial";

export const MAX_COMMAND_BATCH_SIZE = 32;
export const COMMAND_BATCH_PARALLELISM = 4;

export interface CommandBatchSpec {
  readonly executable: string;
  readonly args: readonly string[];
}

export type CommandBatchItem =
  | {
      readonly index: number;
      readonly skipped: false;
      readonly result:
        RunCommandResult;
    }
  | {
      readonly index: number;
      readonly skipped: true;
      readonly executable: string;
      readonly args:
        readonly string[];
      readonly reason:
        "previous_command_failed";
    };

export interface CommandBatchResult {
  readonly ok: boolean;
  readonly mode:
    CommandBatchMode;
  readonly stoppedEarly:
    boolean;
  readonly items:
    readonly CommandBatchItem[];
}

type CommandRunner =
  Pick<
    RunCommandService,
    "run"
  >;

export async function runCommandBatch(
  commands: CommandRunner,
  workspace: string,
  specs:
    readonly CommandBatchSpec[],
  mode:
    CommandBatchMode,
  stopOnFailure:
    boolean,
): Promise<CommandBatchResult> {
  if (mode === "parallel") {
    const results =
      new Array<CommandBatchItem>(specs.length);
    let nextIndex = 0;

    const worker = async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= specs.length) return;

        const spec = specs[index]!;
        results[index] = {
          index,
          skipped: false,
          result:
            await commands.run(
              workspace,
              spec.executable,
              spec.args,
            ),
        };
      }
    };

    await Promise.all(
      Array.from(
        {
          length: Math.min(
            COMMAND_BATCH_PARALLELISM,
            specs.length,
          ),
        },
        worker,
      ),
    );

    return {
      ok:
        results.every(
          (item) =>
            !item.skipped &&
            item.result.ok,
        ),
      mode,
      stoppedEarly: false,
      items: results,
    };
  }

  const items:
    CommandBatchItem[] = [];
  let stoppedEarly =
    false;

  for (
    let index = 0;
    index < specs.length;
    index += 1
  ) {
    const spec =
      specs[index]!;

    if (stoppedEarly) {
      items.push({
        index,
        skipped: true,
        executable:
          spec.executable,
        args: [
          ...spec.args,
        ],
        reason:
          "previous_command_failed",
      });
      continue;
    }

    const result =
      await commands.run(
        workspace,
        spec.executable,
        spec.args,
      );

    items.push({
      index,
      skipped: false,
      result,
    });

    if (
      stopOnFailure &&
      !result.ok
    ) {
      stoppedEarly = true;
    }
  }

  return {
    ok:
      items.every(
        (item) =>
          !item.skipped &&
          item.result.ok,
      ),
    mode,
    stoppedEarly,
    items,
  };
}
