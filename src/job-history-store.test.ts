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
} from "./job-history-store.js";

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
