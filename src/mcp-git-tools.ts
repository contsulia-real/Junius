import type {
  McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  gitCommitPrepared,
  gitPrepareCommit,
  gitSnapshot,
} from "./git-workflow.js";
import type {
  RunCommandResult,
  RunCommandService,
} from "./run-command.js";
import {
  runCommandResultPayload,
  stableIdSchema,
} from "./mcp-tool-shared.js";

function commandPayload(
  result:
    RunCommandResult,
) {
  return runCommandResultPayload(
    result,
  );
}

function snapshotPayload(
  snapshot:
    Awaited<
      ReturnType<
        typeof gitSnapshot
      >
    >,
) {
  return {
    ok:
      snapshot.ok,
    status:
      commandPayload(
        snapshot.status,
      ),
    unstagedStat:
      commandPayload(
        snapshot
          .unstagedStat,
      ),
    unstagedNames:
      commandPayload(
        snapshot
          .unstagedNames,
      ),
    stagedStat:
      commandPayload(
        snapshot
          .stagedStat,
      ),
    stagedNames:
      commandPayload(
        snapshot
          .stagedNames,
      ),
    recentCommits:
      commandPayload(
        snapshot
          .recentCommits,
      ),
  };
}

export function registerGitTools(
  server: McpServer,
  commands:
    RunCommandService,
): void {
  server.registerTool(
    "git_snapshot",
    {
      title:
        "Inspect Git Repository",
      description:
        "Inspect a Git Workspace in one call: branch/status, unstaged stat and name-status, staged stat and name-status, and recent one-line commits. This tool does not mutate the repository.",
      inputSchema:
        z.object({
          workspace:
            stableIdSchema,
          recent_commits:
            z.number()
              .int()
              .min(1)
              .max(20)
              .default(5),
        }),
      _meta: {
        securitySchemes: [
          { type: "noauth" },
        ],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      workspace,
      recent_commits,
    }) => {
      const snapshot =
        await gitSnapshot(
          commands,
          workspace,
          recent_commits,
        );

      return {
        isError:
          !snapshot.ok,
        content: [
          {
            type:
              "text" as const,
            text:
              JSON.stringify(
                snapshotPayload(
                  snapshot,
                ),
              ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "git_prepare_commit",
    {
      title:
        "Prepare Git Commit",
      description:
        "Stage only the explicitly supplied paths, run git diff --cached --check, and return staged name-status, stat, full diff, and a Git tree token. This changes the Git index but does not create a commit or push. Review the returned staged diff before calling git_commit.",
      inputSchema:
        z.object({
          workspace:
            stableIdSchema,
          paths:
            z.array(
              z.string()
                .min(1)
                .max(4_096),
            )
              .min(1)
              .max(256),
        }),
      _meta: {
        securitySchemes: [
          { type: "noauth" },
        ],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      workspace,
      paths,
    }) => {
      const result =
        await gitPrepareCommit(
          commands,
          workspace,
          paths,
        );

      return {
        isError:
          !result.ok,
        content: [
          {
            type:
              "text" as const,
            text:
              JSON.stringify({
                ok:
                  result.ok,
                add:
                  commandPayload(
                    result.add,
                  ),
                ...(
                  result.check ===
                  undefined
                    ? {}
                    : {
                        check:
                          commandPayload(
                            result.check,
                          ),
                      }
                ),
                ...(
                  result
                    .stagedNames ===
                  undefined
                    ? {}
                    : {
                        stagedNames:
                          commandPayload(
                            result
                              .stagedNames,
                          ),
                      }
                ),
                ...(
                  result
                    .stagedStat ===
                  undefined
                    ? {}
                    : {
                        stagedStat:
                          commandPayload(
                            result
                              .stagedStat,
                          ),
                      }
                ),
                ...(
                  result
                    .stagedDiff ===
                  undefined
                    ? {}
                    : {
                        stagedDiff:
                          commandPayload(
                            result
                              .stagedDiff,
                          ),
                      }
                ),
                ...(
                  result
                    .writeTree ===
                  undefined
                    ? {}
                    : {
                        writeTree:
                          commandPayload(
                            result
                              .writeTree,
                          ),
                      }
                ),
                ...(
                  result.tree ===
                  undefined
                    ? {}
                    : {
                        tree:
                          result.tree,
                      }
                ),
              }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "git_commit",
    {
      title:
        "Commit Prepared Git Index",
      description:
        "Create a Git commit only if the current staged tree exactly matches the tree token returned by git_prepare_commit. This prevents committing staged content that changed after review. Returns final Git status and never pushes.",
      inputSchema:
        z.object({
          workspace:
            stableIdSchema,
          expected_tree:
            z.string()
              .regex(
                /^[0-9a-f]{40,64}$/u,
              ),
          message:
            z.string()
              .min(1)
              .max(65_536),
        }),
      _meta: {
        securitySchemes: [
          { type: "noauth" },
        ],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      workspace,
      expected_tree,
      message,
    }) => {
      const result =
        await gitCommitPrepared(
          commands,
          workspace,
          expected_tree,
          message,
        );

      if (
        !result.ok &&
        result.code ===
          "staged_tree_changed"
      ) {
        return {
          isError: true,
          content: [
            {
              type:
                "text" as const,
              text:
                JSON.stringify({
                  ok: false,
                  code:
                    result.code,
                  expectedTree:
                    result
                      .expectedTree,
                  actualTree:
                    result
                      .actualTree,
                  writeTree:
                    commandPayload(
                      result
                        .writeTree,
                    ),
                }),
            },
          ],
        };
      }

      if (!result.ok) {
        return {
          isError: true,
          content: [
            {
              type:
                "text" as const,
              text:
                JSON.stringify({
                  ok: false,
                  code:
                    result.code,
                  step:
                    result.step,
                  result:
                    commandPayload(
                      result.result,
                    ),
                }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type:
              "text" as const,
            text:
              JSON.stringify({
                ok: true,
                tree:
                  result.tree,
                commit:
                  commandPayload(
                    result.commit,
                  ),
                status:
                  commandPayload(
                    result.status,
                  ),
              }),
          },
        ],
      };
    },
  );
}
