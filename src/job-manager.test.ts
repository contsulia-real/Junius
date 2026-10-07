import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobHistoryStore } from "./job-history-store.js";
import {
  JobManager,
  JobManagerError,
} from "./job-manager.js";
import { RunCommandService } from "./run-command.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";

async function fixture(
  onTerminal?:
    ConstructorParameters<
      typeof JobManager
    >[1],
  history?:
    ConstructorParameters<
      typeof JobManager
    >[2],
) {
  const root =
    await mkdtemp(
      join(
        tmpdir(),
        "junius-jobs-",
      ),
    );

  const workspaces =
    new WorkspaceManager([
      {
        id: "demo",
        profile:
          new WorkspaceProfile(
            root,
          ),
      },
    ]);

  const commands =
    new RunCommandService(
      workspaces,
    );
  const jobs =
    new JobManager(
      commands,
      onTerminal,
      history,
    );

  return {
    root,
    commands,
    jobs,
    async dispose() {
      await jobs.close();
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
  "JobManager starts, waits, and reads arbitrary process output",
  async () => {
    const f =
      await fixture();
    try {
      const started =
        await f.jobs.start(
          "demo",
          process.execPath,
          [
            "-e",
            "console.log('hello'); setTimeout(() => console.error('done'), 40)",
          ],
        );

      assert.equal(
        started.executable,
        process.execPath,
      );
      assert.equal(
        started.status,
        "running",
      );
      assert.ok(
        started.pid,
      );

      const finished =
        await f.jobs.wait(
          started.id,
          2_000,
        );
      assert.equal(
        finished.status,
        "succeeded",
      );
      assert.equal(
        finished.exitCode,
        0,
      );

      const stdout =
        await f.jobs
          .readOutput(
            started.id,
            "stdout",
          );
      const stderr =
        await f.jobs
          .readOutput(
            started.id,
            "stderr",
          );

      assert.equal(
        stdout.content,
        "hello\n",
      );
      assert.equal(
        stderr.content,
        "done\n",
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "JobManager emits one terminal snapshot when a job finishes",
  async () => {
    const terminalJobs:
      string[] = [];
    const f =
      await fixture(
        (job) => {
          terminalJobs.push(
            `${job.id}:${job.status}`,
          );
        },
      );

    try {
      const started =
        await f.jobs.start(
          "demo",
          process.execPath,
          [
            "-e",
            "setTimeout(() => {}, 20)",
          ],
        );

      const finished =
        await f.jobs.wait(
          started.id,
          2_000,
        );
      assert.equal(
        finished.status,
        "succeeded",
      );
      assert.deepEqual(
        terminalJobs,
        [
          `${started.id}:succeeded`,
        ],
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "JobManager output supports cursors",
  async () => {
    const f =
      await fixture();
    try {
      const started =
        await f.jobs.start(
          "demo",
          process.execPath,
          [
            "-e",
            "process.stdout.write('abcdef')",
          ],
        );
      await f.jobs.wait(
        started.id,
        2_000,
      );

      const first =
        await f.jobs
          .readOutput(
            started.id,
            "stdout",
            0,
            3,
          );
      const second =
        await f.jobs
          .readOutput(
            started.id,
            "stdout",
            first.nextOffset,
            3,
          );

      assert.equal(
        first.content,
        "abc",
      );
      assert.equal(
        second.content,
        "def",
      );
      assert.equal(
        second.eof,
        true,
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "JobManager cancels a running process",
  async () => {
    const f =
      await fixture();
    try {
      const started =
        await f.jobs.start(
          "demo",
          process.execPath,
          [
            "-e",
            "setInterval(() => {}, 1000)",
          ],
        );

      const cancelled =
        await f.jobs.cancel(
          started.id,
        );
      assert.equal(
        cancelled.status,
        "cancelled",
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "JobManager rejects an unknown Workspace",
  async () => {
    const commands =
      new RunCommandService(
        new WorkspaceManager(),
      );
    const jobs =
      new JobManager(
        commands,
      );

    try {
      await assert.rejects(
        jobs.start(
          "missing",
          process.execPath,
          ["--version"],
        ),
        (
          error: unknown,
        ) =>
          error instanceof
            JobManagerError &&
          error.code ===
            "workspace_not_registered",
      );
    } finally {
      await jobs.close();
    }
  },
);

test(
  "JobManager persists terminal history across manager restart",
  async () => {
    const root =
      await mkdtemp(
        join(
          tmpdir(),
          "junius-job-history-",
        ),
      );
    const historyPath =
      join(
        root,
        "history",
      );

    const workspaces =
      new WorkspaceManager([
        {
          id: "demo",
          profile:
            new WorkspaceProfile(
              root,
            ),
        },
      ]);
    const commands =
      new RunCommandService(
        workspaces,
      );

    const persistedJobs:
      string[] = [];
    const first =
      new JobManager(
        commands,
        undefined,
        new JobHistoryStore(
          historyPath,
        ),
        (job) => {
          persistedJobs.push(
            `${job.id}:${job.status}`,
          );
        },
      );
    let second:
      JobManager | undefined;

    try {
      const started =
        await first.start(
          "demo",
          process.execPath,
          [
            "-e",
            "console.log('persisted-out'); console.error('persisted-err')",
          ],
        );
      const finished =
        await first.wait(
          started.id,
          2_000,
        );
      assert.equal(
        finished.status,
        "succeeded",
      );

      await first.close();
      assert.deepEqual(
        persistedJobs,
        [
          `${started.id}:succeeded`,
        ],
      );

      second =
        new JobManager(
          commands,
          undefined,
          new JobHistoryStore(
            historyPath,
          ),
        );

      const restored =
        await second.get(
          started.id,
        );
      assert.equal(
        restored.status,
        "succeeded",
      );
      assert.equal(
        restored.executable,
        process.execPath,
      );

      const stdout =
        await second.readOutput(
          started.id,
          "stdout",
        );
      const stderr =
        await second.readOutput(
          started.id,
          "stderr",
        );
      assert.equal(
        stdout.content,
        "persisted-out\n",
      );
      assert.equal(
        stderr.content,
        "persisted-err\n",
      );
    } finally {
      await first.close();
      await second?.close();
      await rm(
        root,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);


test(
  "JobManager can wait and return incremental stdout and stderr together",
  async () => {
    const f = await fixture();

    try {
      const started = await f.jobs.start(
        "demo",
        process.execPath,
        [
          "-e",
          "process.stdout.write('out'); process.stderr.write('err'); setTimeout(() => {}, 30)",
        ],
      );

      const result = await f.jobs.waitWithOutput(
        started.id,
        2_000,
        0,
        0,
        64,
      );

      assert.equal(result.job.status, "succeeded");
      assert.equal(result.stdout?.content, "out");
      assert.equal(result.stderr?.content, "err");
      assert.equal(result.stdout?.nextOffset, 3);
      assert.equal(result.stderr?.nextOffset, 3);
    } finally {
      await f.dispose();
    }
  },
);
