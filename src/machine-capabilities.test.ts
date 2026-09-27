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
import { DesktopComputerUseService } from "./desktop-computer-use.js";
import { MachineCapabilityStateStore } from "./machine-capability-state-store.js";
import {
  MachineCapabilityManager,
  type MachineCapabilityServices,
} from "./machine-capabilities.js";
import { PlaywrightCliService } from "./playwright-cli.js";

function services(root: string): MachineCapabilityServices {
  return {
    browser: new PlaywrightCliService({
      ...process.env,
      PATH: "",
      JUNIUS_BROWSER_STATE_PATH: join(root, "browser"),
    }),
    desktop: new DesktopComputerUseService({
      helperPath: join(root, "missing-desktop-helper.py"),
      pythonExecutable: join(root, "missing-python.exe"),
      platform: "win32",
    }),
  };
}

test("MachineCapabilityManager registers available built-ins by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "junius-machine-cap-"));
  try {
    const pnpmExecutable = join(root, "pnpm.exe");
    await writeFile(pnpmExecutable, "fake", "utf8");

    const gitExecutable = join(root, "git.exe");
    await writeFile(gitExecutable, "fake", "utf8");

    const registry = new CapabilityRegistry();
    const store = new MachineCapabilityStateStore(
      join(root, "state.json"),
    );
    const manager = await MachineCapabilityManager.create(
      registry,
      store,
      services(root),
      {
        ...process.env,
        PATH: root,
      },
      process.execPath,
    );

    assert.equal(registry.has("node"), true);
    assert.equal(registry.has("pnpm"), true);
    assert.equal(registry.has("git"), true);

    assert.deepEqual(
      manager.list().map((capability) => ({
        key: capability.key,
        scope: capability.scope,
        enabled: capability.enabled,
        available: capability.available,
        active: capability.active,
      })),
      [
        {
          key: "node",
          scope: "workspace",
          enabled: true,
          available: true,
          active: true,
        },
        {
          key: "pnpm",
          scope: "workspace",
          enabled: true,
          available: true,
          active: true,
        },
        {
          key: "git",
          scope: "workspace",
          enabled: true,
          available: true,
          active: true,
        },
        {
          key: "browser",
          scope: "machine",
          enabled: true,
          available: false,
          active: false,
        },
        {
          key: "desktop",
          scope: "machine",
          enabled: true,
          available: false,
          active: false,
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
    const firstServices = services(root);
    const first = await MachineCapabilityManager.create(
      firstRegistry,
      firstStore,
      firstServices,
      {
        ...process.env,
        PATH: "",
      },
      process.execPath,
    );

    await first.setEnabled("node", false);
    await first.setEnabled("browser", false);

    assert.equal(firstRegistry.has("node"), false);
    assert.equal(firstServices.browser.enabled, false);

    const secondRegistry = new CapabilityRegistry();
    const secondStore = new MachineCapabilityStateStore(statePath);
    const secondServices = services(root);
    const second = await MachineCapabilityManager.create(
      secondRegistry,
      secondStore,
      secondServices,
      {
        ...process.env,
        PATH: "",
      },
      process.execPath,
    );

    const node = second.list().find(
      (capability) => capability.key === "node",
    );
    const browser = second.list().find(
      (capability) => capability.key === "browser",
    );

    assert.equal(node?.enabled, false);
    assert.equal(node?.available, true);
    assert.equal(node?.active, false);
    assert.equal(secondRegistry.has("node"), false);
    assert.equal(browser?.enabled, false);
    assert.equal(browser?.active, false);
    assert.equal(secondServices.browser.enabled, false);
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
      services(root),
      {
        ...process.env,
        PATH: "",
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

test("MachineCapabilityManager validates Workspace grants against machine policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "junius-machine-cap-"));

  try {
    const manager = await MachineCapabilityManager.create(
      new CapabilityRegistry(),
      new MachineCapabilityStateStore(join(root, "state.json")),
      services(root),
      {
        ...process.env,
        PATH: "",
      },
      process.execPath,
    );

    assert.deepEqual(
      manager.workspaceGrantCompatibility("pnpm", {
        mode: "exact",
        args: ["run", "check"],
      }),
      { valid: true },
    );
    assert.deepEqual(
      manager.workspaceGrantCompatibility("pnpm", {
        mode: "prefix",
        args: ["run", "check"],
      }),
      { valid: true },
    );
    assert.deepEqual(
      manager.workspaceGrantCompatibility("pnpm", {
        mode: "prefix",
        args: ["run"],
      }),
      { valid: true },
    );
    assert.deepEqual(
      manager.workspaceGrantCompatibility("pnpm", {
        mode: "prefix",
        args: ["add"],
      }),
      { valid: true },
    );
    for (const args of [
      ["typecheck"],
      ["lint"],
      ["test"],
      ["build"],
      ["install"],
      ["update"],
      ["self-update"],
      ["add", "react"],
    ]) {
      assert.deepEqual(
        manager.workspaceGrantCompatibility("pnpm", {
          mode: "exact",
          args,
        }),
        { valid: true },
      );
    }
    assert.deepEqual(
      manager.workspaceGrantCompatibility("pnpm", {
        mode: "exact",
        args: ["add"],
      }),
      {
        valid: false,
        reason: "arguments_outside_machine_policy",
      },
    );
    assert.deepEqual(
      manager.workspaceGrantCompatibility("git", {
        mode: "prefix",
        args: ["remote"],
      }),
      { valid: true },
    );
    assert.deepEqual(
      manager.workspaceGrantCompatibility("browser", {
        mode: "exact",
        args: ["open"],
      }),
      {
        valid: false,
        reason: "capability_not_workspace_scoped",
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MachineCapabilityManager reloads persisted machine capability state", async () => {
  const root = await mkdtemp(join(tmpdir(), "junius-machine-cap-"));
  const statePath = join(root, "state.json");

  try {
    const registry = new CapabilityRegistry();
    const store = new MachineCapabilityStateStore(statePath);
    const machineServices = services(root);
    const manager = await MachineCapabilityManager.create(
      registry,
      store,
      machineServices,
      {
        ...process.env,
        PATH: "",
      },
      process.execPath,
    );

    await store.save({
      node: { enabled: false },
      pnpm: { enabled: false },
      git: { enabled: false },
      browser: { enabled: false },
      desktop: { enabled: false },
    });
    await manager.reload();

    assert.equal(registry.has("node"), false);
    assert.equal(registry.has("pnpm"), false);
    assert.equal(registry.has("git"), false);
    assert.equal(machineServices.browser.enabled, false);
    assert.equal(machineServices.desktop.enabled, false);
    assert.equal(
      manager.list().every((capability) => !capability.enabled),
      true,
    );
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
      services(root),
      {
        ...process.env,
        PATH: "",
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
