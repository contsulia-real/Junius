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
      controlPort: 20_000 + Math.floor(Math.random() * 1_000),
      internalToken: `token-${id}-012345678901234567890123456789`,
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

test("WorkerSupervisor skips validation and candidate startup when Host is already stale", async () => {
  const first = fakeWorker("worker-1");
  let validateCount = 0;
  let spawnCount = 0;

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    
    canPromote: () => false,
    validate: async () => {
      validateCount += 1;
      return check(true);
    },
    spawnWorker: async () => {
      spawnCount += 1;
      return first.worker;
    },
    spawnInitialWorker: async () => first.worker,
  });

  try {
    await supervisor.startInitial();

    const result = await supervisor.reload(
      "host-already-stale",
    );

    assert.equal(result.promoted, false);
    assert.equal(
      result.reason,
      "candidate_promotion_blocked",
    );
    assert.equal(validateCount, 0);
    assert.equal(spawnCount, 0);
    assert.equal(
      supervisor.state().activeWorkerId,
      first.worker.id,
    );
    assert.equal(first.closed(), false);
  } finally {
    await supervisor.close();
  }
});

test("WorkerSupervisor refuses candidate promotion when Host becomes stale", async () => {
  const first = fakeWorker("worker-1");
  const second = fakeWorker("worker-2");
  let canPromote = true;
  let spawnCount = 0;

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    
    validate: async () => check(true),
    canPromote: () => canPromote,
    spawnWorker: async () => {
      spawnCount += 1;
      if (spawnCount === 1) {
        return first.worker;
      }

      canPromote = false;
      return second.worker;
    },
  });

  try {
    await supervisor.startInitial();

    const result = await supervisor.reload(
      "host-became-stale",
    );

    assert.equal(result.promoted, false);
    assert.equal(
      result.reason,
      "candidate_promotion_blocked",
    );
    assert.equal(
      supervisor.state().activeWorkerId,
      first.worker.id,
    );
    assert.equal(first.closed(), false);
    assert.equal(second.closed(), true);
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
    
    rollbackWindowMs: 10_000,
    validate: async () => check(true),
    spawnWorker: async () => queue.shift()!,
  });

  try {
    await supervisor.startInitial();
    supervisor.bindResource("job:11111111-1111-4111-8111-111111111111", first.worker.id);
    await supervisor.reload("good-edit");

    const lease = supervisor.acquire(
      undefined,
      "job:11111111-1111-4111-8111-111111111111",
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

    supervisor.releaseResource("job:11111111-1111-4111-8111-111111111111");

    const newLease = supervisor.acquire(
      undefined,
      "job:11111111-1111-4111-8111-111111111111",
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
    
    rollbackWindowMs: 5,
    jobResultRetentionMs: 100,
    validate: async () => check(true),
    spawnWorker: async () => queue.shift()!,
  });

  try {
    await supervisor.startInitial();
    supervisor.bindResource("job:11111111-1111-4111-8111-111111111111", first.worker.id);
    await supervisor.reload("good-edit");

    await delay(15);
    assert.equal(first.closed(), false);
    assert.equal(
      supervisor.state().resourceBindings.find(
        (binding) => binding.key === "job:11111111-1111-4111-8111-111111111111",
      )?.expiresAt,
      undefined,
    );

    first.message({
      type: "junius-job-terminal",
      workerId: first.worker.id,
      jobId: "11111111-1111-4111-8111-111111111111",
    });

    assert.equal(
      typeof supervisor.state().resourceBindings.find(
        (binding) => binding.key === "job:11111111-1111-4111-8111-111111111111",
      )?.expiresAt,
      "string",
    );

    await delay(20);
    const lease = supervisor.acquire(
      undefined,
      "job:11111111-1111-4111-8111-111111111111",
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
    
    rollbackWindowMs: 30,
    jobResultRetentionMs: 1_000,
    validate: async () => check(true),
    spawnWorker: async () => queue.shift()!,
  });

  try {
    await supervisor.startInitial();
    supervisor.bindResource("job:22222222-2222-4222-8222-222222222222", first.worker.id);
    await supervisor.reload("good-edit");

    first.message({
      type: "junius-job-terminal",
      workerId: first.worker.id,
      jobId: "22222222-2222-4222-8222-222222222222",
    });

    assert.equal(
      typeof supervisor.state().resourceBindings.find(
        (binding) => binding.key === "job:22222222-2222-4222-8222-222222222222",
      )?.expiresAt,
      "string",
    );

    first.message({
      type: "junius-job-history-persisted",
      workerId: first.worker.id,
      jobId: "22222222-2222-4222-8222-222222222222",
    });

    assert.equal(
      supervisor.state().resourceBindings.some(
        (binding) => binding.key === "job:22222222-2222-4222-8222-222222222222",
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
    
    validate: async () => check(true),
    spawnWorker: async () => first.worker,
  });

  try {
    await supervisor.startInitial();

    first.message({
      type: "junius-job-terminal",
      workerId: first.worker.id,
      jobId: "33333333-3333-4333-8333-333333333333",
    });
    first.message({
      type: "junius-job-history-persisted",
      workerId: first.worker.id,
      jobId: "33333333-3333-4333-8333-333333333333",
    });

    supervisor.bindResource(
      "job:33333333-3333-4333-8333-333333333333",
      first.worker.id,
    );

    assert.equal(
      supervisor.state().resourceBindings.some(
        (binding) =>
          binding.key === "job:33333333-3333-4333-8333-333333333333",
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
    
    jobResultRetentionMs: 50,
    validate: async () => check(true),
    spawnWorker: async () => first.worker,
  });

  try {
    await supervisor.startInitial();
    first.message({
      type: "junius-job-terminal",
      workerId: first.worker.id,
      jobId: "44444444-4444-4444-8444-444444444444",
    });

    supervisor.bindResource(
      "job:44444444-4444-4444-8444-444444444444",
      first.worker.id,
    );

    assert.equal(
      typeof supervisor.state().resourceBindings.find(
        (binding) => binding.key === "job:44444444-4444-4444-8444-444444444444",
      )?.expiresAt,
      "string",
    );
  } finally {
    await supervisor.close();
  }
});

test("WorkerSupervisor ignores malformed or mismatched runtime Job IPC", async () => {
  const first = fakeWorker("worker-1");

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    
    validate: async () => check(true),
    spawnWorker: async () => first.worker,
  });

  try {
    await supervisor.startInitial();

    first.message({
      type: "junius-job-terminal",
      workerId: first.worker.id,
      jobId: "not-a-uuid",
    });
    first.message({
      type: "junius-job-terminal",
      workerId: "worker-other",
      jobId: "55555555-5555-4555-8555-555555555555",
    });

    supervisor.bindResource("job:not-a-uuid", first.worker.id);
    supervisor.bindResource(
      "job:55555555-5555-4555-8555-555555555555",
      first.worker.id,
    );

    for (const key of [
      "job:not-a-uuid",
      "job:55555555-5555-4555-8555-555555555555",
    ]) {
      assert.equal(
        supervisor.state().resourceBindings.find(
          (binding) => binding.key === key,
        )?.expiresAt,
        undefined,
      );
    }
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

test("WorkerSupervisor synchronizes configuration to retiring affinity workers", async () => {
  const first = fakeWorker("worker-1");
  const second = fakeWorker("worker-2");
  const queue = [first.worker, second.worker];
  const reloaded: string[] = [];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    
    rollbackWindowMs: 10_000,
    validate: async () => check(true),
    spawnWorker: async () => queue.shift()!,
    reloadWorkerConfiguration: async (worker) => {
      reloaded.push(worker.id);
    },
  });

  try {
    await supervisor.startInitial();
    supervisor.bindSession("session-a", first.worker.id);
    await supervisor.reload("promote-worker-2");

    const result = await supervisor.synchronizeConfiguration(
      second.worker.id,
    );

    assert.deepEqual(result, {
      synchronizedWorkerIds: [first.worker.id],
      quarantinedWorkerIds: [],
    });
    assert.deepEqual(reloaded, [first.worker.id]);

    const oldLease = supervisor.acquire("session-a");
    try {
      assert.equal(oldLease.worker.id, first.worker.id);
    } finally {
      oldLease.release();
    }
  } finally {
    await supervisor.close();
  }
});

test("WorkerSupervisor quarantines a retiring worker that cannot reload configuration", async () => {
  const first = fakeWorker("worker-1");
  const second = fakeWorker("worker-2");
  const queue = [first.worker, second.worker];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    
    rollbackWindowMs: 10_000,
    validate: async () => check(true),
    spawnWorker: async () => queue.shift()!,
    reloadWorkerConfiguration: async (worker) => {
      if (worker.id === first.worker.id) {
        throw new Error("reload failed");
      }
    },
  });

  try {
    await supervisor.startInitial();
    supervisor.bindSession("session-a", first.worker.id);
    await supervisor.reload("promote-worker-2");

    const result = await supervisor.synchronizeConfiguration(
      second.worker.id,
    );

    assert.deepEqual(result, {
      synchronizedWorkerIds: [],
      quarantinedWorkerIds: [first.worker.id],
    });
    assert.equal(first.closed(), true);

    const lease = supervisor.acquire("session-a");
    try {
      assert.equal(lease.worker.id, second.worker.id);
    } finally {
      lease.release();
    }
  } finally {
    await supervisor.close();
  }
});

test("WorkerSupervisor refreshes a candidate when configuration changes during startup", async () => {
  const first = fakeWorker("worker-1");
  const second = fakeWorker("worker-2");
  let releaseSpawn!: () => void;
  let reportSpawnStarted!: () => void;
  const spawnGate = new Promise<void>((resolve) => {
    releaseSpawn = resolve;
  });
  const spawnStarted = new Promise<void>((resolve) => {
    reportSpawnStarted = resolve;
  });
  const reloaded: string[] = [];

  const supervisor = new WorkerSupervisor({
    cwd: process.cwd(),
    publicMcpOrigin: "http://127.0.0.1:8787",
    
    rollbackWindowMs: 10_000,
    validate: async () => check(true),
    spawnInitialWorker: async () => first.worker,
    spawnWorker: async () => {
      reportSpawnStarted();
      await spawnGate;
      return second.worker;
    },
    reloadWorkerConfiguration: async (worker) => {
      reloaded.push(worker.id);
    },
  });

  try {
    await supervisor.startInitial();
    const reload = supervisor.reload("concurrent-config-change");
    await spawnStarted;

    await supervisor.synchronizeConfiguration(first.worker.id);
    releaseSpawn();

    const result = await reload;
    assert.equal(result.promoted, true);
    assert.deepEqual(reloaded, [second.worker.id]);
  } finally {
    releaseSpawn();
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
