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

test("MachineCapabilityStateStore round-trips v3 built-in and custom capability state", async () => {
  const directory = await mkdtemp(
    join(
      tmpdir(),
      "junius-machine-cap-state-",
    ),
  );
  const filePath = join(
    directory,
    "state.json",
  );

  try {
    const store =
      new MachineCapabilityStateStore(
        filePath,
      );

    const expected = {
      node: { enabled: false },
      pnpm: { enabled: true },
      custom_node: {
        enabled: true,
        custom: {
          key: "custom_node",
          description: "Custom Node",
          executable: process.execPath,
          fixedArgs: [],
          argumentPolicy: [
            {
              mode: "exact" as const,
              args: ["--version"],
            },
          ],
          timeoutMs: 15_000,
          maxOutputBytes: 65_536,
          environmentPolicy: {
            inherit:
              "allowlist" as const,
            allowNames: [
              "PATH",
              "SystemRoot",
            ],
            denyNames: [
              "NODE_OPTIONS",
            ],
            denyPrefixes: ["GIT_"],
            set: {
              CUSTOM_VALUE: "1",
            },
          },
        },
      },
    };

    await store.save(expected);
    assert.deepEqual(
      await store.load(),
      expected,
    );

    const raw = JSON.parse(
      await readFile(
        filePath,
        "utf8",
      ),
    ) as {
      version: number;
    };
    assert.equal(raw.version, 3);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("MachineCapabilityStateStore migrates v1 and v2 state without changing legacy custom environment behavior", async () => {
  const directory = await mkdtemp(
    join(
      tmpdir(),
      "junius-machine-cap-state-",
    ),
  );
  const v1Path = join(
    directory,
    "v1.json",
  );
  const v2Path = join(
    directory,
    "v2.json",
  );

  try {
    await writeFile(
      v1Path,
      JSON.stringify({
        version: 1,
        capabilities: {
          node: { enabled: false },
        },
      }),
      "utf8",
    );

    const v1Store =
      new MachineCapabilityStateStore(
        v1Path,
      );
    assert.deepEqual(
      await v1Store.load(),
      {
        node: { enabled: false },
      },
    );

    await writeFile(
      v2Path,
      JSON.stringify({
        version: 2,
        capabilities: {
          custom_node: {
            enabled: true,
            custom: {
              key: "custom_node",
              description:
                "Legacy Custom Node",
              executable:
                process.execPath,
              fixedArgs: [],
              argumentPolicy: [
                {
                  mode: "exact",
                  args: ["--version"],
                },
              ],
              timeoutMs: 15_000,
              maxOutputBytes: 65_536,
            },
          },
        },
      }),
      "utf8",
    );

    const v2Store =
      new MachineCapabilityStateStore(
        v2Path,
      );
    const migrated =
      await v2Store.load();

    assert.deepEqual(
      migrated?.custom_node
        ?.custom
        ?.environmentPolicy,
      {
        inherit: "all",
        allowNames: [],
        denyNames: [],
        denyPrefixes: [],
        set: {},
      },
    );

    await v2Store.save(migrated!);
    const raw = JSON.parse(
      await readFile(
        v2Path,
        "utf8",
      ),
    ) as { version: number };
    assert.equal(raw.version, 3);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("MachineCapabilityStateStore reports missing state as uninitialized", async () => {
  const directory = await mkdtemp(
    join(
      tmpdir(),
      "junius-machine-cap-state-",
    ),
  );

  try {
    const store =
      new MachineCapabilityStateStore(
        join(
          directory,
          "missing.json",
        ),
      );

    assert.equal(
      await store.load(),
      undefined,
    );
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
