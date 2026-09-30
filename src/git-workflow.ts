import type {
  RunCommandResult,
  RunCommandService,
} from "./run-command.js";

type CommandRunner =
  Pick<
    RunCommandService,
    "run"
  >;

export interface GitSnapshotResult {
  readonly ok: boolean;
  readonly status:
    RunCommandResult;
  readonly unstagedStat:
    RunCommandResult;
  readonly unstagedNames:
    RunCommandResult;
  readonly stagedStat:
    RunCommandResult;
  readonly stagedNames:
    RunCommandResult;
  readonly recentCommits:
    RunCommandResult;
}

export async function gitSnapshot(
  commands: CommandRunner,
  workspace: string,
  recentCommitCount: number,
): Promise<GitSnapshotResult> {
  const [
    status,
    unstagedStat,
    unstagedNames,
    stagedStat,
    stagedNames,
    recentCommits,
  ] = await Promise.all([
    commands.run(
      workspace,
      "git",
      [
        "status",
        "--short",
        "--branch",
      ],
    ),
    commands.run(
      workspace,
      "git",
      [
        "diff",
        "--stat",
      ],
    ),
    commands.run(
      workspace,
      "git",
      [
        "diff",
        "--name-status",
      ],
    ),
    commands.run(
      workspace,
      "git",
      [
        "diff",
        "--cached",
        "--stat",
      ],
    ),
    commands.run(
      workspace,
      "git",
      [
        "diff",
        "--cached",
        "--name-status",
      ],
    ),
    commands.run(
      workspace,
      "git",
      [
        "log",
        `-${recentCommitCount}`,
        "--oneline",
      ],
    ),
  ]);

  return {
    ok:
      [
        status,
        unstagedStat,
        unstagedNames,
        stagedStat,
        stagedNames,
        recentCommits,
      ].every(
        (result) =>
          result.ok,
      ),
    status,
    unstagedStat,
    unstagedNames,
    stagedStat,
    stagedNames,
    recentCommits,
  };
}

export interface GitPrepareCommitResult {
  readonly ok: boolean;
  readonly add:
    RunCommandResult;
  readonly check?:
    RunCommandResult;
  readonly stagedNames?:
    RunCommandResult;
  readonly stagedStat?:
    RunCommandResult;
  readonly stagedDiff?:
    RunCommandResult;
  readonly writeTree?:
    RunCommandResult;
  readonly tree?: string;
}

export async function gitPrepareCommit(
  commands: CommandRunner,
  workspace: string,
  paths:
    readonly string[],
): Promise<GitPrepareCommitResult> {
  const add =
    await commands.run(
      workspace,
      "git",
      [
        "add",
        "--",
        ...paths,
      ],
    );

  if (!add.ok) {
    return {
      ok: false,
      add,
    };
  }

  const check =
    await commands.run(
      workspace,
      "git",
      [
        "diff",
        "--cached",
        "--check",
      ],
    );

  if (!check.ok) {
    return {
      ok: false,
      add,
      check,
    };
  }

  const [
    stagedNames,
    stagedStat,
    stagedDiff,
    writeTree,
  ] = await Promise.all([
    commands.run(
      workspace,
      "git",
      [
        "diff",
        "--cached",
        "--name-status",
      ],
    ),
    commands.run(
      workspace,
      "git",
      [
        "diff",
        "--cached",
        "--stat",
      ],
    ),
    commands.run(
      workspace,
      "git",
      [
        "diff",
        "--cached",
      ],
    ),
    commands.run(
      workspace,
      "git",
      [
        "write-tree",
      ],
    ),
  ]);

  const ok =
    stagedNames.ok &&
    stagedStat.ok &&
    stagedDiff.ok &&
    writeTree.ok;

  return {
    ok,
    add,
    check,
    stagedNames,
    stagedStat,
    stagedDiff,
    writeTree,
    ...(
      writeTree.ok
        ? {
            tree:
              writeTree
                .execution
                .stdout
                .trim(),
          }
        : {}
    ),
  };
}

export type GitCommitResult =
  | {
      readonly ok: false;
      readonly code:
        "staged_tree_changed";
      readonly expectedTree:
        string;
      readonly actualTree:
        string;
      readonly writeTree:
        RunCommandResult;
    }
  | {
      readonly ok: false;
      readonly code:
        "git_command_failed";
      readonly step:
        "write_tree" |
        "commit" |
        "status";
      readonly result:
        RunCommandResult;
    }
  | {
      readonly ok: true;
      readonly tree: string;
      readonly commit:
        RunCommandResult;
      readonly status:
        RunCommandResult;
    };

export async function gitCommitPrepared(
  commands: CommandRunner,
  workspace: string,
  expectedTree: string,
  message: string,
): Promise<GitCommitResult> {
  const writeTree =
    await commands.run(
      workspace,
      "git",
      [
        "write-tree",
      ],
    );

  if (!writeTree.ok) {
    return {
      ok: false,
      code:
        "git_command_failed",
      step:
        "write_tree",
      result:
        writeTree,
    };
  }

  const actualTree =
    writeTree
      .execution
      .stdout
      .trim();

  if (
    actualTree !==
    expectedTree
  ) {
    return {
      ok: false,
      code:
        "staged_tree_changed",
      expectedTree,
      actualTree,
      writeTree,
    };
  }

  const commit =
    await commands.run(
      workspace,
      "git",
      [
        "commit",
        "-m",
        message,
      ],
    );

  if (!commit.ok) {
    return {
      ok: false,
      code:
        "git_command_failed",
      step:
        "commit",
      result:
        commit,
    };
  }

  const status =
    await commands.run(
      workspace,
      "git",
      [
        "status",
        "--short",
        "--branch",
      ],
    );

  if (!status.ok) {
    return {
      ok: false,
      code:
        "git_command_failed",
      step:
        "status",
      result:
        status,
    };
  }

  return {
    ok: true,
    tree:
      actualTree,
    commit,
    status,
  };
}
