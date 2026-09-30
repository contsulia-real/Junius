import type {
  RunCommandResult,
  RunCommandService,
} from "./run-command.js";

export type CommandBatchMode =
  | "parallel"
  | "serial";

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
      await Promise.all(
        specs.map(
          async (
            spec,
            index,
          ): Promise<CommandBatchItem> => ({
            index,
            skipped: false,
            result:
              await commands.run(
                workspace,
                spec.executable,
                spec.args,
              ),
          }),
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
