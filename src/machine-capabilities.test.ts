import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { MachineCapabilityStateStore } from "./machine-capability-state-store.js";
import { MachineCapabilityManager } from "./machine-capabilities.js";

test("MachineCapabilityManager registers available built-ins by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "junius-machine-cap-"));
  try {
    const pnpmHome = join(root, "pnpm-home");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(pnpmHome, { recursive: true }),
    );
    await writeFile(
      join(pnpmHome, "pnpm.js"),
      "process.exit(0)\n",
      "utf8",
    );

    const gitExecutable = join(root, "git.exe");
    await writeFile(gitExecutable, "fake", "utf8");

    const registry = new CapabilityRegistry();
    const store = new MachineCapabilityStateStore(
      join(root, "state.json"),
    );
    const manager = await MachineCapabilityManager.create(
      registry,
      store,
      {
        ...process.env,
        PATH: "",
        npm_execpath: undefined,
        PNPM_HOME: pnpmHome,
        JUNIUS_GIT_PATH: gitExecutable,
      },
      process.execPath,
    );

    assert.equal(registry.has("node"), true);
    assert.equal(registry.has("pnpm"), true);
    assert.equal(registry.has("git"), true);

    assert.deepEqual(
      manager.list().map((capability) => ({
        key: capability.key,
        enabled: capability.enabled,
        available: capability.available,
        active: capability.active,
      })),
      [
        {
          key: "node",
          enabled: true,
          available: true,
          active: true,
        },
        {
          key: "pnpm",
          enabled: true,
          available: true,
          active: true,
        },
        {
          key: "git",
          enabled: true,
          available: true,
          active: true,
        },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MachineCapabilityManager persists disabled state across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "junius-machine-cap-"));
  const statePath = join(root, "state.json");

  try {
    const firstRegistry = new CapabilityRegistry();
    const firstStore = new MachineCapabilityStateStore(statePath);
    const first = await MachineCapabilityManager.create(
      firstRegistry,
      firstStore,
      {
        ...process.env,
        PATH: "",
        npm_execpath: undefined,
        PNPM_HOME: undefined,
        JUNIUS_GIT_PATH: undefined,
      },
      process.execPath,
    );

    await first.setEnabled("node", false);

    assert.equal(firstRegistry.has("node"), false);

    const secondRegistry = new CapabilityRegistry();
    const secondStore = new MachineCapabilityStateStore(statePath);
    const second = await MachineCapabilityManager.create(
      secondRegistry,
      secondStore,
      {
        ...process.env,
        PATH: "",
        npm_execpath: undefined,
        PNPM_HOME: undefined,
        JUNIUS_GIT_PATH: undefined,
      },
      process.execPath,
    );

    const node = second.list().find(
      (capability) => capability.key === "node",
    );

    assert.equal(node?.enabled, false);
    assert.equal(node?.available, true);
    assert.equal(node?.active, false);
    assert.equal(secondRegistry.has("node"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MachineCapabilityManager keeps unavailable launchers distinct from disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "junius-machine-cap-"));

  try {
    const registry = new CapabilityRegistry();
    const store = new MachineCapabilityStateStore(
      join(root, "state.json"),
    );
    const manager = await MachineCapabilityManager.create(
      registry,
      store,
      {
        ...process.env,
        PATH: "",
        npm_execpath: undefined,
        PNPM_HOME: undefined,
        JUNIUS_GIT_PATH: undefined,
        ProgramFiles: undefined,
        "ProgramFiles(x86)": undefined,
        LOCALAPPDATA: undefined,
      },
      process.execPath,
    );

    for (const key of ["pnpm", "git"] as const) {
      const capability = manager.list().find(
        (item) => item.key === key,
      );

      assert.equal(capability?.enabled, true);
      assert.equal(capability?.available, false);
      assert.equal(capability?.active, false);
      assert.equal(registry.has(key), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MachineCapabilityManager rejects unknown capability keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "junius-machine-cap-"));

  try {
    const manager = await MachineCapabilityManager.create(
      new CapabilityRegistry(),
      new MachineCapabilityStateStore(join(root, "state.json")),
      {
        ...process.env,
        PATH: "",
        npm_execpath: undefined,
        PNPM_HOME: undefined,
        JUNIUS_GIT_PATH: undefined,
      },
      process.execPath,
    );

    await assert.rejects(
      manager.setEnabled("arbitrary-shell", true),
      /machine_capability_not_known/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
