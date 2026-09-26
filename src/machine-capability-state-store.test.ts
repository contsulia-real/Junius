import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MachineCapabilityStateStore } from "./machine-capability-state-store.js";

test("MachineCapabilityStateStore round-trips enabled state", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "junius-machine-cap-state-"),
  );
  const filePath = join(directory, "state.json");

  try {
    const store = new MachineCapabilityStateStore(filePath);

    await store.save({
      node: { enabled: false },
      pnpm: { enabled: true },
    });

    assert.deepEqual(await store.load(), {
      node: { enabled: false },
      pnpm: { enabled: true },
    });

    const raw = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
    };
    assert.equal(raw.version, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MachineCapabilityStateStore reports missing state as uninitialized", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "junius-machine-cap-state-"),
  );

  try {
    const store = new MachineCapabilityStateStore(
      join(directory, "missing.json"),
    );

    assert.equal(await store.load(), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
