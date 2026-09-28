import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
    assert.equal(raw.version, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MachineCapabilityStateStore migrates v1 state on read", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "junius-machine-cap-state-"),
  );
  const filePath = join(directory, "state.json");

  try {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        capabilities: {
          node: { enabled: false },
        },
      }),
      "utf8",
    );

    const store = new MachineCapabilityStateStore(filePath);
    assert.deepEqual(await store.load(), {
      node: { enabled: false },
    });

    await store.save((await store.load())!);
    const raw = JSON.parse(
      await readFile(filePath, "utf8"),
    ) as { version: number };
    assert.equal(raw.version, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MachineCapabilityStateStore round-trips custom definitions", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "junius-machine-cap-state-"),
  );
  const filePath = join(directory, "state.json");

  try {
    const store = new MachineCapabilityStateStore(filePath);
    await store.save({
      custom_node: {
        enabled: true,
        custom: {
          key: "custom_node",
          description: "Custom Node",
          executable: process.execPath,
          fixedArgs: [],
          argumentPolicy: [
            { mode: "exact", args: ["--version"] },
          ],
          timeoutMs: 15_000,
          maxOutputBytes: 65_536,
        },
      },
    });

    assert.deepEqual(
      await store.load(),
      {
        custom_node: {
          enabled: true,
          custom: {
            key: "custom_node",
            description: "Custom Node",
            executable: process.execPath,
            fixedArgs: [],
            argumentPolicy: [
              { mode: "exact", args: ["--version"] },
            ],
            timeoutMs: 15_000,
            maxOutputBytes: 65_536,
          },
        },
      },
    );
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
