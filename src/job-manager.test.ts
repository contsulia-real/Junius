import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { ProcessCapability } from "./capabilities/process-capability.js";
import { JobManager, JobManagerError } from "./job-manager.js";
import { RunCommandService } from "./run-command.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";

async function fixture(
  onTerminal?: ConstructorParameters<typeof JobManager>[1],
) {
  const root = await mkdtemp(join(tmpdir(), "junius-jobs-"));
  const registry = new CapabilityRegistry();

  registry.register(
    new ProcessCapability({
      key: "test-node",
      description: "test node job",
      executable: process.execPath,
      argumentPolicy: (args) => args[0] === "-e",
      timeoutMs: 5_000,
    }),
  );

  const workspaces = new WorkspaceManager([
    {
      id: "demo",
      profile: new WorkspaceProfile(root, [
        {
          key: "test-node",
          arguments: [
            {
              mode: "prefix",
              args: ["-e"],
            },
          ],
        },
      ]),
    },
  ]);

  const commands = new RunCommandService(registry, workspaces);
  const jobs = new JobManager(commands, onTerminal);

  return {
    root,
    jobs,
    async dispose() {
      await jobs.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("JobManager starts, waits, and reads process output", async () => {
  const f = await fixture();
  try {
    const started = f.jobs.start(
      "demo",
      "test-node",
      [
        "-e",
        "console.log('hello'); setTimeout(() => console.error('done'), 40)",
      ],
    );

    assert.equal(started.status, "running");
    assert.ok(started.pid);

    const finished = await f.jobs.wait(started.id, 2_000);
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.exitCode, 0);

    const stdout = f.jobs.readOutput(started.id, "stdout");
    const stderr = f.jobs.readOutput(started.id, "stderr");

    assert.equal(stdout.content, "hello\n");
    assert.equal(stdout.eof, true);
    assert.equal(stderr.content, "done\n");
    assert.equal(stderr.eof, true);
  } finally {
    await f.dispose();
  }
});

test("JobManager emits one terminal snapshot when a job finishes", async () => {
  const terminalJobs: string[] = [];
  const f = await fixture((job) => {
    terminalJobs.push(`${job.id}:${job.status}`);
  });

  try {
    const started = f.jobs.start(
      "demo",
      "test-node",
      ["-e", "setTimeout(() => {}, 20)"],
    );

    const finished = await f.jobs.wait(started.id, 2_000);
    assert.equal(finished.status, "succeeded");
    assert.deepEqual(terminalJobs, [
      `${started.id}:succeeded`,
    ]);
  } finally {
    await f.dispose();
  }
});

test("JobManager output supports cursors", async () => {
  const f = await fixture();
  try {
    const started = f.jobs.start(
      "demo",
      "test-node",
      ["-e", "process.stdout.write('abcdef')"],
    );
    await f.jobs.wait(started.id, 2_000);

    const first = f.jobs.readOutput(
      started.id,
      "stdout",
      0,
      3,
    );
    const second = f.jobs.readOutput(
      started.id,
      "stdout",
      first.nextOffset,
      3,
    );

    assert.equal(first.content, "abc");
    assert.equal(second.content, "def");
    assert.equal(second.eof, true);
  } finally {
    await f.dispose();
  }
});

test("JobManager cancels a running process", async () => {
  const f = await fixture();
  try {
    const started = f.jobs.start(
      "demo",
      "test-node",
      ["-e", "setInterval(() => {}, 1000)"],
    );

    const cancelled = await f.jobs.cancel(started.id);
    assert.equal(cancelled.status, "cancelled");
  } finally {
    await f.dispose();
  }
});

test("JobManager reuses Workspace command authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "junius-jobs-deny-"));
  try {
    const registry = new CapabilityRegistry();
    registry.register(
      new ProcessCapability({
        key: "test-node",
        description: "test node job",
        executable: process.execPath,
        argumentPolicy: () => true,
      }),
    );

    const commands = new RunCommandService(
      registry,
      new WorkspaceManager([
        {
          id: "demo",
          profile: new WorkspaceProfile(root),
        },
      ]),
    );
    const jobs = new JobManager(commands);

    assert.throws(
      () => jobs.start("demo", "test-node", ["--version"]),
      (error: unknown) =>
        error instanceof JobManagerError &&
        error.code === "capability_not_allowed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("JobManager exposes runtime job snapshots", async () => {
  const f = await fixture();
  try {
    const started = f.jobs.start(
      "demo",
      "test-node",
      ["-e", "setTimeout(() => {}, 30)"],
    );

    const listed = f.jobs.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, started.id);
    assert.equal(listed[0]?.workspace, "demo");

    await f.jobs.wait(started.id, 2_000);
  } finally {
    await f.dispose();
  }
});
