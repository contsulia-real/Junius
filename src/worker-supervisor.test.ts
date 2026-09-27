import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import type { SourceCheckResult } from "./source-check.js";
import type { ManagedWorker } from "./worker-process.js";
import { WorkerSupervisor } from "./worker-supervisor.js";

function check(ok: boolean): SourceCheckResult {
  return {
    ok,
    exitCode: ok ? 0 : 1,
    signal: null,
    stdout: "",
    stderr: ok ? "" : "broken",
    durationMs: 1,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeWorker(id: string): {
  worker: ManagedWorker;
  exit(): void;
  message(value: unknown): void;
  closed(): boolean;
} {
  const child = new EventEmitter() as unknown as ChildProcess;
  let exited = false;
  let closed = false;

  return {
    worker: {
      id,
      child,
      pid: Number(id.replace(/\D/gu, "")) || 1,
      mcpPort: 10_000 + Math.floor(Math.random() * 1_000),
      adminPort: 20_000 + Math.floor(Math.random() * 1_000),
      startedAt: new Date().toISOString(),
      stdout: () => "",
      stderr: () => "",
      exited: () => exited,
      async close() {
        if (exited) return;
        closed = true;
        exited = true;
        child.emit("exit", 0, null);
      },
    },
    exit() {
      if (exited) return;
      exited = true;
      child.emit("exit", 1, null);
    },
    message(value: unknown) {
      child.emit("message", value);
    },
    closed: () => closed,
  };
}

test("WorkerSupervisor keeps active worker when source validation fails", async () => {
  const first = fakeWorker("worker-1");
  let spawnCount = 0;

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 10_000,
    validate: async () => check(false),
    spawnWorker: async () => {
      spawnCount += 1;
      return first.worker;
    },
  });

  try {
    await supervisor.startInitial();
    const result = await supervisor.reload("broken-edit");

    assert.equal(result.promoted, false);
    assert.equal(spawnCount, 1);
    assert.equal(
      supervisor.state().activeWorkerId,
      "worker-1",
    );
    assert.equal(first.closed(), false);
  } finally {
    await supervisor.close();
  }
});

test("WorkerSupervisor can boot from a release worker then reload from live source", async () => {
  const releaseWorker = fakeWorker("worker-1");
  const liveWorker = fakeWorker("worker-2");
  let initialSpawns = 0;
  let liveSpawns = 0;

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 10_000,
    validate: async () => check(true),
    spawnInitialWorker: async () => {
      initialSpawns += 1;
      return releaseWorker.worker;
    },
    spawnWorker: async () => {
      liveSpawns += 1;
      return liveWorker.worker;
    },
  });

  try {
    const initial = await supervisor.startInitial();
    assert.equal(initial.id, releaseWorker.worker.id);
    assert.equal(initialSpawns, 1);
    assert.equal(liveSpawns, 0);

    const result = await supervisor.reload("live-edit");
    assert.equal(result.promoted, true);
    assert.equal(result.workerId, liveWorker.worker.id);
    assert.equal(initialSpawns, 1);
    assert.equal(liveSpawns, 1);
  } finally {
    await supervisor.close();
  }
});

test("WorkerSupervisor promotes healthy candidate while existing session stays on old worker", async () => {
  const first = fakeWorker("worker-1");
  const second = fakeWorker("worker-2");
  const queue = [first.worker, second.worker];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 10_000,
    validate: async () => check(true),
    spawnWorker: async () => queue.shift()!,
  });

  try {
    await supervisor.startInitial();
    supervisor.bindSession("session-a", first.worker.id);

    const result = await supervisor.reload("good-edit");
    assert.equal(result.promoted, true);
    assert.equal(result.workerId, second.worker.id);
    assert.equal(
      supervisor.state().activeWorkerId,
      second.worker.id,
    );

    const oldLease = supervisor.acquire("session-a");
    const newLease = supervisor.acquire();
    try {
      assert.equal(oldLease.worker.id, first.worker.id);
      assert.equal(newLease.worker.id, second.worker.id);
    } finally {
      oldLease.release();
      newLease.release();
    }

    assert.equal(first.closed(), false);
  } finally {
    await supervisor.close();
  }
});

test("WorkerSupervisor keeps resource affinity on retiring worker until released", async () => {
  const first = fakeWorker("worker-1");
  const second = fakeWorker("worker-2");
  const queue = [first.worker, second.worker];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 10_000,
    validate: async () => check(true),
    spawnWorker: async () => queue.shift()!,
  });

  try {
    await supervisor.startInitial();
    supervisor.bindResource("job:abc", first.worker.id);
    await supervisor.reload("good-edit");

    const lease = supervisor.acquire(
      undefined,
      "job:abc",
    );
    try {
      assert.equal(lease.worker.id, first.worker.id);
    } finally {
      lease.release();
    }

    assert.equal(
      supervisor.state().workers.find(
        (worker) => worker.id === first.worker.id,
      )?.resources,
      1,
    );

    supervisor.releaseResource("job:abc");

    const newLease = supervisor.acquire(
      undefined,
      "job:abc",
    );
    try {
      assert.equal(newLease.worker.id, second.worker.id);
    } finally {
      newLease.release();
    }
  } finally {
    await supervisor.close();
  }
});

test("WorkerSupervisor expires idle browser affinity without violating rollback window", async () => {
  const first = fakeWorker("worker-1");
  const second = fakeWorker("worker-2");
  const queue = [first.worker, second.worker];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 500,
    browserResourceIdleMs: 20,
    validate: async () => check(true),
    spawnWorker: async () => queue.shift()!,
  });

  try {
    await supervisor.startInitial();
    supervisor.bindResource(
      "browser:idle",
      first.worker.id,
    );
    await supervisor.reload("good-edit");

    await delay(80);
    assert.equal(first.closed(), false);
    assert.equal(
      supervisor.state().resourceBindings.some(
        (binding) => binding.key === "browser:idle",
      ),
      false,
    );

    await delay(500);
    assert.equal(first.closed(), true);
  } finally {
    await supervisor.close();
  }
});

test("WorkerSupervisor keeps jobs pinned until terminal IPC then expires retained results", async () => {
  const first = fakeWorker("worker-1");
  const second = fakeWorker("worker-2");
  const queue = [first.worker, second.worker];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 5,
    jobResultRetentionMs: 100,
    validate: async () => check(true),
    spawnWorker: async () => queue.shift()!,
  });

  try {
    await supervisor.startInitial();
    supervisor.bindResource("job:abc", first.worker.id);
    await supervisor.reload("good-edit");

    await delay(15);
    assert.equal(first.closed(), false);
    assert.equal(
      supervisor.state().resourceBindings.find(
        (binding) => binding.key === "job:abc",
      )?.expiresAt,
      undefined,
    );

    first.message({
      type: "junius-job-terminal",
      workerId: first.worker.id,
      jobId: "abc",
    });

    assert.equal(
      typeof supervisor.state().resourceBindings.find(
        (binding) => binding.key === "job:abc",
      )?.expiresAt,
      "string",
    );

    await delay(20);
    const lease = supervisor.acquire(
      undefined,
      "job:abc",
    );
    lease.release();

    await delay(40);
    assert.equal(first.closed(), false);

    await delay(80);
    assert.equal(first.closed(), true);
  } finally {
    await supervisor.close();
  }
});

test("WorkerSupervisor releases terminal job affinity after history persistence", async () => {
  const first = fakeWorker("worker-1");
  const second = fakeWorker("worker-2");
  const queue = [first.worker, second.worker];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 30,
    jobResultRetentionMs: 1_000,
    validate: async () => check(true),
    spawnWorker: async () => queue.shift()!,
  });

  try {
    await supervisor.startInitial();
    supervisor.bindResource("job:persisted", first.worker.id);
    await supervisor.reload("good-edit");

    first.message({
      type: "junius-job-terminal",
      workerId: first.worker.id,
      jobId: "persisted",
    });

    assert.equal(
      typeof supervisor.state().resourceBindings.find(
        (binding) => binding.key === "job:persisted",
      )?.expiresAt,
      "string",
    );

    first.message({
      type: "junius-job-history-persisted",
      workerId: first.worker.id,
      jobId: "persisted",
    });

    assert.equal(
      supervisor.state().resourceBindings.some(
        (binding) => binding.key === "job:persisted",
      ),
      false,
    );

    await delay(40);
    assert.equal(first.closed(), true);
  } finally {
    await supervisor.close();
  }
});

test("WorkerSupervisor skips job affinity when persisted history arrives before binding", async () => {
  const first = fakeWorker("worker-1");

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    validate: async () => check(true),
    spawnWorker: async () => first.worker,
  });

  try {
    await supervisor.startInitial();

    first.message({
      type: "junius-job-terminal",
      workerId: first.worker.id,
      jobId: "fast-persisted",
    });
    first.message({
      type: "junius-job-history-persisted",
      workerId: first.worker.id,
      jobId: "fast-persisted",
    });

    supervisor.bindResource(
      "job:fast-persisted",
      first.worker.id,
    );

    assert.equal(
      supervisor.state().resourceBindings.some(
        (binding) =>
          binding.key === "job:fast-persisted",
      ),
      false,
    );
  } finally {
    await supervisor.close();
  }
});

test("WorkerSupervisor remembers terminal IPC that arrives before job binding", async () => {
  const first = fakeWorker("worker-1");

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    jobResultRetentionMs: 50,
    validate: async () => check(true),
    spawnWorker: async () => first.worker,
  });

  try {
    await supervisor.startInitial();
    first.message({
      type: "junius-job-terminal",
      workerId: first.worker.id,
      jobId: "fast",
    });

    supervisor.bindResource(
      "job:fast",
      first.worker.id,
    );

    assert.equal(
      typeof supervisor.state().resourceBindings.find(
        (binding) => binding.key === "job:fast",
      )?.expiresAt,
      "string",
    );
  } finally {
    await supervisor.close();
  }
});

test("WorkerSupervisor bounds idle MCP session routes and refreshes active affinity", async () => {
  const first = fakeWorker("worker-1");
  const second = fakeWorker("worker-2");
  const queue = [first.worker, second.worker];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 5,
    mcpSessionIdleMs: 30,
    validate: async () => check(true),
    spawnWorker: async () => queue.shift()!,
  });

  try {
    await supervisor.startInitial();
    supervisor.bindSession(
      "session-a",
      first.worker.id,
    );

    await delay(40);
    assert.equal(first.closed(), false);
    assert.equal(
      supervisor.state().workers.find(
        (worker) => worker.id === first.worker.id,
      )?.sessions,
      0,
    );

    const activeLease = supervisor.acquire("session-a");
    assert.equal(activeLease.worker.id, first.worker.id);
    activeLease.release();

    supervisor.bindSession(
      "session-a",
      first.worker.id,
    );
    await supervisor.reload("good-edit");

    await delay(15);
    const oldLease = supervisor.acquire("session-a");
    assert.equal(oldLease.worker.id, first.worker.id);
    oldLease.release();

    await delay(20);
    assert.equal(first.closed(), false);

    await delay(25);
    assert.equal(first.closed(), true);

    const migrated = supervisor.acquire("session-a");
    assert.equal(migrated.worker.id, second.worker.id);
    migrated.release();
  } finally {
    await supervisor.close();
  }
});

test("WorkerSupervisor expires unbound Job race hints", async () => {
  const first = fakeWorker("worker-1");

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    jobResultRetentionMs: 20,
    validate: async () => check(true),
    spawnWorker: async () => first.worker,
  });

  try {
    await supervisor.startInitial();

    supervisor.markJobHistoryPersisted(
      first.worker.id,
      "persisted-late",
    );
    await delay(35);
    supervisor.bindResource(
      "job:persisted-late",
      first.worker.id,
    );

    const persistedBinding =
      supervisor.state().resourceBindings.find(
        (binding) =>
          binding.key === "job:persisted-late",
      );
    assert.equal(
      persistedBinding?.workerId,
      first.worker.id,
    );

    supervisor.releaseResource(
      "job:persisted-late",
    );

    supervisor.markJobTerminal(
      first.worker.id,
      "terminal-late",
    );
    await delay(35);
    supervisor.bindResource(
      "job:terminal-late",
      first.worker.id,
    );

    const terminalBinding =
      supervisor.state().resourceBindings.find(
        (binding) =>
          binding.key === "job:terminal-late",
      );
    assert.equal(
      terminalBinding?.workerId,
      first.worker.id,
    );
    assert.equal(
      terminalBinding?.expiresAt,
      undefined,
    );
  } finally {
    await supervisor.close();
  }
});

test("WorkerSupervisor bounds retained exited worker diagnostics", async () => {
  const workers = [
    fakeWorker("worker-1"),
    fakeWorker("worker-2"),
    fakeWorker("worker-3"),
    fakeWorker("worker-4"),
  ];
  const queue = workers.map((entry) => entry.worker);

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 1,
    maxExitedRecords: 1,
    validate: async () => check(true),
    spawnWorker: async () => queue.shift()!,
  });

  try {
    await supervisor.startInitial();

    for (let index = 0; index < 3; index += 1) {
      const result = await supervisor.reload(
        `edit-${index}`,
      );
      assert.equal(result.promoted, true);
      await delay(20);
    }

    const state = supervisor.state();
    assert.equal(
      state.activeWorkerId,
      workers[3]!.worker.id,
    );
    assert.equal(
      state.workers.filter(
        (worker) => worker.status === "exited",
      ).length <= 1,
      true,
    );
    assert.equal(state.workers.length <= 2, true);
  } finally {
    await supervisor.close();
  }
});

test("WorkerSupervisor rolls back when newly active worker exits inside rollback window", async () => {
  const first = fakeWorker("worker-1");
  const second = fakeWorker("worker-2");
  const queue = [first.worker, second.worker];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    publicAdminOrigin: "http://127.0.0.1:8788",
    rollbackWindowMs: 10_000,
    validate: async () => check(true),
    spawnWorker: async () => queue.shift()!,
  });

  try {
    await supervisor.startInitial();
    await supervisor.reload("good-edit");
    assert.equal(
      supervisor.state().activeWorkerId,
      second.worker.id,
    );

    second.exit();

    assert.equal(
      supervisor.state().activeWorkerId,
      first.worker.id,
    );
    assert.match(
      supervisor.state().lastFailure ?? "",
      /rolled_back_to/u,
    );
  } finally {
    await supervisor.close();
  }
});
