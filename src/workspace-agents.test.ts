import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runWorkspaceReadBatch,
} from "./workspace-batch.js";
import {
  WorkspaceFileError,
  WorkspaceFilesService,
} from "./workspace-files.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";

async function fixture() {
  const root = await mkdtemp(
    join(
      tmpdir(),
      "junius-agents-",
    ),
  );

  await mkdir(
    join(
      root,
      "src",
      "deep",
    ),
    {
      recursive: true,
    },
  );
  await mkdir(
    join(
      root,
      "docs",
    ),
    {
      recursive: true,
    },
  );

  await writeFile(
    join(
      root,
      "AGENTS.md",
    ),
    "root instructions\n",
    "utf8",
  );
  await writeFile(
    join(
      root,
      "src",
      "AGENTS.md",
    ),
    "src instructions\n",
    "utf8",
  );
  await writeFile(
    join(
      root,
      "src",
      "deep",
      "AGENTS.md",
    ),
    "deep instructions\n",
    "utf8",
  );
  await writeFile(
    join(
      root,
      "src",
      "deep",
      "a.ts",
    ),
    "old\n",
    "utf8",
  );
  await writeFile(
    join(
      root,
      "docs",
      "guide.md",
    ),
    "guide\n",
    "utf8",
  );

  const service =
    new WorkspaceFilesService(
      new WorkspaceManager([
        {
          id: "demo",
          profile:
            new WorkspaceProfile(
              root,
            ),
        },
      ]),
    );

  return {
    root,
    service,
    async dispose() {
      await rm(
        root,
        {
          recursive: true,
          force: true,
        },
      );
    },
  };
}

test(
  "AGENTS.md instructions follow directory scope with deeper rules later",
  async () => {
    const f =
      await fixture();

    try {
      const instructions =
        await f.service
          .agentInstructionsForPaths(
            "demo",
            [
              "src/deep/a.ts",
            ],
          );

      assert.deepEqual(
        instructions.instructions
          .map(
            (item) => ({
              path: item.path,
              scope: item.scope,
              depth: item.depth,
              content: item.content,
            }),
          ),
        [
          {
            path: "AGENTS.md",
            scope: ".",
            depth: 0,
            content:
              "root instructions\n",
          },
          {
            path:
              "src/AGENTS.md",
            scope: "src",
            depth: 1,
            content:
              "src instructions\n",
          },
          {
            path:
              "src/deep/AGENTS.md",
            scope:
              "src/deep",
            depth: 2,
            content:
              "deep instructions\n",
          },
        ],
      );

      assert.match(
        instructions.digest,
        /^[a-f0-9]{64}$/u,
      );

      const docs =
        await f.service
          .agentInstructionsForPaths(
            "demo",
            [
              "docs/guide.md",
            ],
          );
      assert.deepEqual(
        docs.instructions.map(
          (item) =>
            item.path,
        ),
        [
          "AGENTS.md",
        ],
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "recursive Workspace scans surface nested AGENTS.md instructions",
  async () => {
    const f =
      await fixture();

    try {
      const result =
        await runWorkspaceReadBatch(
          f.service,
          "demo",
          [
            {
              id: "tree",
              op: "ls",
              path: ".",
              depth: 4,
            },
            {
              id: "search",
              op: "rg",
              query: "old",
              path: "src",
              fixedStrings: true,
              caseSensitive: true,
            },
          ],
        );

      for (
        const item of
        result.results
      ) {
        const record =
          item as {
            agentInstructions?: {
              instructions: Array<{
                path: string;
              }>;
            };
          };

        assert.deepEqual(
          record
            .agentInstructions
            ?.instructions
            .map(
              (instruction) =>
                instruction.path,
            ),
          [
            "AGENTS.md",
            "src/AGENTS.md",
            "src/deep/AGENTS.md",
          ],
        );
      }
    } finally {
      await f.dispose();
    }
  },
);

test(
  "Workspace mutations require the current AGENTS.md digest before changing files",
  async () => {
    const f =
      await fixture();

    try {
      let requiredDigest:
        string | undefined;

      await assert.rejects(
        f.service.write(
          "demo",
          [
            {
              path:
                "src/deep/a.ts",
              content:
                "blocked\n",
            },
          ],
        ),
        (error: unknown) => {
          if (
            !(
              error instanceof
              WorkspaceFileError
            ) ||
            error.code !==
              "agents_ack_required"
          ) {
            return false;
          }

          const details =
            error.details as {
              agentsDigest?: string;
              agentInstructions?: Array<{
                path: string;
              }>;
            };

          requiredDigest =
            details.agentsDigest;
          assert.deepEqual(
            details
              .agentInstructions
              ?.map(
                (item) =>
                  item.path,
              ),
            [
              "AGENTS.md",
              "src/AGENTS.md",
              "src/deep/AGENTS.md",
            ],
          );
          return true;
        },
      );

      assert.equal(
        await readFile(
          join(
            f.root,
            "src",
            "deep",
            "a.ts",
          ),
          "utf8",
        ),
        "old\n",
      );
      assert.match(
        requiredDigest ?? "",
        /^[a-f0-9]{64}$/u,
      );

      await f.service.write(
        "demo",
        [
          {
            path:
              "src/deep/a.ts",
            content:
              "allowed\n",
          },
        ],
        "write",
        requiredDigest,
      );

      assert.equal(
        await readFile(
          join(
            f.root,
            "src",
            "deep",
            "a.ts",
          ),
          "utf8",
        ),
        "allowed\n",
      );

      await writeFile(
        join(
          f.root,
          "src",
          "deep",
          "AGENTS.md",
        ),
        "changed deep instructions\n",
        "utf8",
      );

      await assert.rejects(
        f.service.write(
          "demo",
          [
            {
              path:
                "src/deep/a.ts",
              content:
                "stale digest\n",
            },
          ],
          "write",
          requiredDigest,
        ),
        (error: unknown) =>
          error instanceof
            WorkspaceFileError &&
          error.code ===
            "agents_ack_required",
      );

      assert.equal(
        await readFile(
          join(
            f.root,
            "src",
            "deep",
            "a.ts",
          ),
          "utf8",
        ),
        "allowed\n",
      );
    } finally {
      await f.dispose();
    }
  },
);
