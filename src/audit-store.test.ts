import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditStore } from "./audit-store.js";

test("AuditStore enforces the retained entry limit under concurrent writes", async () => {
  const root = await mkdtemp(
    join(
      tmpdir(),
      "junius-audit-concurrent-",
    ),
  );

  try {
    const store = new AuditStore(
      root,
      {
        maxEntries: 10,
        maxAgeMs: 60_000,
      },
    );

    for (let index = 0; index < 200; index += 1) {
      store.record({
        category: "command",
        action: `event-${String(index)}`,
        status: "succeeded",
      });
    }
    await store.close();

    const files = await import("node:fs/promises")
      .then(({ readdir }) => readdir(root));

    assert.equal(
      files.filter((name) => name.endsWith(".json")).length,
      10,
    );
  } finally {
    await rm(
      root,
      {
        recursive: true,
        force: true,
      },
    );
  }
});

test("AuditStore enforces the retained entry limit across concurrent stores", async () => {
  const root = await mkdtemp(
    join(
      tmpdir(),
      "junius-audit-multi-store-",
    ),
  );

  try {
    const retention = {
      maxEntries: 10,
      maxAgeMs: 60_000,
    };
    const first =
      new AuditStore(root, retention);
    const second =
      new AuditStore(root, retention);

    for (let index = 0; index < 200; index += 1) {
      const store =
        index % 2 === 0
          ? first
          : second;
      store.record({
        category: "command",
        action: `event-${String(index)}`,
        status: "succeeded",
      });
    }

    await Promise.all([
      first.close(),
      second.close(),
    ]);

    const files = await import("node:fs/promises")
      .then(({ readdir }) => readdir(root));

    assert.equal(
      files.filter((name) => name.endsWith(".json")).length,
      10,
    );
  } finally {
    await rm(
      root,
      {
        recursive: true,
        force: true,
      },
    );
  }
});

test("AuditStore persists events and bounds retained history", async () => {
  const root = await mkdtemp(
    join(
      tmpdir(),
      "junius-audit-",
    ),
  );

  try {
    const store = new AuditStore(
      root,
      {
        maxEntries: 2,
        maxAgeMs: 60_000,
      },
    );

    store.record({
      category: "command",
      action: "first",
      status: "succeeded",
    });
    store.record({
      category: "job",
      action: "second",
      status: "started",
    });
    store.record({
      category: "workspace",
      action: "third",
      status: "succeeded",
    });
    assert.deepEqual(
      store.recent(2).map(
        (event) => event.action,
      ),
      [
        "third",
        "second",
      ],
    );
    await store.close();

    const reopened = new AuditStore(
      root,
      {
        maxEntries: 2,
        maxAgeMs: 60_000,
      },
    );
    const events =
      await reopened.list(10);

    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map(
        (event) => event.action,
      ),
      ["third", "second"],
    );
    assert.deepEqual(
      await reopened.stats(),
      {
        entries: 2,
        retention: {
          maxEntries: 2,
          maxAgeMs: 60_000,
        },
      },
    );
  } finally {
    await rm(
      root,
      {
        recursive: true,
        force: true,
      },
    );
  }
});
