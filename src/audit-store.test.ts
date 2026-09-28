import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditStore } from "./audit-store.js";

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
