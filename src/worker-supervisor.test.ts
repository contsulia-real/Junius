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
    rollbackWindowMs: 30,
    browserResourceIdleMs: 5,
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

    await delay(12);
    assert.equal(first.closed(), false);
    assert.equal(
      supervisor.state().resourceBindings.some(
        (binding) => binding.key === "browser:idle",
      ),
      false,
    );

    await delay(35);
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
