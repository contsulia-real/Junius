import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  JobHistoryStore,
  resolveJobHistoryPath,
  resolveJobHistoryRetention,
  type PersistedJobRecord,
} from "./job-history-store.js";

function record(
  id: string,
  endedAt: string,
): PersistedJobRecord {
  return {
    version: 1,
    id,
    workspace: "demo",
    key: "node",
    status: "succeeded",
    pid: 123,
    startedAt: "2026-09-27T00:00:00.000Z",
    endedAt,
    exitCode: 0,
    signal: null,
    stdoutChars: 3,
    stderrChars: 0,
    stdout: "abc",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

test("resolveJobHistoryPath honors JUNIUS_RUNTIME_ROOT", () => {
  const runtimeRoot = join(
    tmpdir(),
    "junius-custom-runtime",
  );

  assert.equal(
    resolveJobHistoryPath(
      {
        JUNIUS_RUNTIME_ROOT: runtimeRoot,
        JUNIUS_PROJECT_ROOT: "ignored-project-root",
      },
      "ignored-cwd",
    ),
    join(resolve(runtimeRoot), "jobs"),
  );
});

test("resolveJobHistoryRetention is opt-in and ignores invalid values", () => {
  assert.deepEqual(
    resolveJobHistoryRetention({}),
    {},
  );

  assert.deepEqual(
    resolveJobHistoryRetention({
      JUNIUS_JOB_HISTORY_MAX_ENTRIES: "25",
      JUNIUS_JOB_HISTORY_MAX_AGE_MS: "60000",
    }),
    {
      maxEntries: 25,
      maxAgeMs: 60_000,
    },
  );

  assert.deepEqual(
    resolveJobHistoryRetention({
      JUNIUS_JOB_HISTORY_MAX_ENTRIES: "0",
      JUNIUS_JOB_HISTORY_MAX_AGE_MS: "nope",
    }),
    {},
  );
});

test("JobHistoryStore defaults to retaining all terminal history", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-job-retain-all-"),
  );
  const store = new JobHistoryStore(root);

  try {
    const ids = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];

    for (const [index, id] of ids.entries()) {
      await store.save(
        record(
          id,
          `2026-09-27T00:00:0${index + 1}.000Z`,
        ),
      );
    }

    assert.equal(
      (await store.listMetadata()).length,
      3,
    );
    assert.deepEqual(await store.prune(), []);

    const stats = await store.stats();
    assert.equal(stats.entries, 3);
    assert.equal(stats.capturedBytes > 0, true);
    assert.deepEqual(stats.retention, {});
    assert.equal(
      stats.oldestEndedAt,
      "2026-09-27T00:00:01.000Z",
    );
    assert.equal(
      stats.newestEndedAt,
      "2026-09-27T00:00:03.000Z",
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("JobHistoryStore prunes only when explicit retention is configured", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-job-retention-"),
  );
  const store = new JobHistoryStore(root, {
    maxEntries: 2,
  });

  try {
    const ids = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];

    for (const [index, id] of ids.entries()) {
      await store.save(
        record(
          id,
          `2026-09-27T00:00:0${index + 1}.000Z`,
        ),
      );
    }

    const listed = await store.listMetadata();
    assert.deepEqual(
      listed
        .map((item) => item.id)
        .sort(),
      ids.slice(1).sort(),
    );

    const stats = await store.stats();
    assert.equal(stats.entries, 2);
    assert.deepEqual(stats.retention, {
      maxEntries: 2,
    });
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("JobHistoryStore supports explicit age pruning with a supplied clock", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-job-age-retention-"),
  );
  const writer = new JobHistoryStore(root);

  try {
    const oldId = randomUUID();
    const newId = randomUUID();

    await writer.save(
      record(
        oldId,
        "2026-09-27T00:00:00.000Z",
      ),
    );
    await writer.save(
      record(
        newId,
        "2026-09-27T00:10:00.000Z",
      ),
    );

    const pruningStore = new JobHistoryStore(
      root,
      { maxAgeMs: 5 * 60_000 },
    );
    const removed = await pruningStore.prune(
      Date.parse("2026-09-27T00:12:00.000Z"),
    );

    assert.deepEqual(removed, [oldId]);
    assert.equal(
      await pruningStore.loadMetadata(oldId),
      undefined,
    );
    assert.equal(
      (await pruningStore.loadMetadata(newId))?.id,
      newId,
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("JobHistoryStore invalidates cached metadata pruned by another store", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-job-cache-prune-"),
  );
  const reader = new JobHistoryStore(root);
  const writer = new JobHistoryStore(root);
  const oldId = randomUUID();
  const newId = randomUUID();

  try {
    await writer.save(
      record(
        oldId,
        "2026-09-27T00:00:01.000Z",
      ),
    );
    await writer.save(
      record(
        newId,
        "2026-09-27T00:00:02.000Z",
      ),
    );

    assert.equal(
      (await reader.loadMetadata(oldId))?.id,
      oldId,
    );

    const pruningStore = new JobHistoryStore(
      root,
      { maxEntries: 1 },
    );
    assert.deepEqual(
      await pruningStore.prune(),
      [oldId],
    );

    assert.equal(
      await reader.loadMetadata(oldId),
      undefined,
    );
    assert.equal(
      (await reader.loadMetadata(newId))?.id,
      newId,
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("JobHistoryStore bounds its hot metadata cache", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-job-cache-"),
  );
  const store = new JobHistoryStore(
    root,
    {},
    1,
  );
  const firstId = randomUUID();
  const secondId = randomUUID();

  try {
    await store.save(
      record(
        firstId,
        "2026-09-27T00:00:01.000Z",
      ),
    );
    await store.save(
      record(
        secondId,
        "2026-09-27T00:00:02.000Z",
      ),
    );

    const stats = await store.stats();
    assert.equal(stats.metadataCacheEntries, 1);
    assert.equal(stats.metadataCacheLimit, 1);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("JobHistoryStore lists metadata without reading captured output", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-job-store-"),
  );
  const store = new JobHistoryStore(root);
  const id = randomUUID();

  try {
    await store.save({
      version: 1,
      id,
      workspace: "demo",
      key: "node",
      status: "succeeded",
      pid: 123,
      startedAt: "2026-09-27T00:00:00.000Z",
      endedAt: "2026-09-27T00:00:01.000Z",
      exitCode: 0,
      signal: null,
      stdoutChars: 3,
      stderrChars: 0,
      stdout: "abc",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });

    await rm(
      join(root, id, "stdout.txt"),
      { force: true },
    );

    const metadata = await store.loadMetadata(id);
    assert.equal(metadata?.stdoutChars, 3);

    const listed = await store.listMetadata();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, id);

    assert.equal(await store.load(id), undefined);

    assert.equal(
      await store.loadMetadata(
        "00000000-0000-0000-0000-000000000000",
      ),
      undefined,
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
