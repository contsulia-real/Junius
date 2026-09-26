import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleAdminRequest } from "./admin-server.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { JobManager } from "./job-manager.js";
import { MachineCapabilityStateStore } from "./machine-capability-state-store.js";
import { MachineCapabilityManager } from "./machine-capabilities.js";
import { PlaywrightCliService } from "./playwright-cli.js";
import { RunCommandService } from "./run-command.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceStateStore } from "./workspace-state-store.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "junius-admin-"));
  const statePath = join(root, "workspace-state.json");
  const registry = new CapabilityRegistry();

  const machineStore = new MachineCapabilityStateStore(
    join(root, "machine-capability-state.json"),
  );
  const machineCapabilities = await MachineCapabilityManager.create(
    registry,
    machineStore,
    {
      ...process.env,
      PATH: "",
      npm_execpath: undefined,
      PNPM_HOME: undefined,
    },
    process.execPath,
  );

  const workspaces = new WorkspaceManager();
  const store = new WorkspaceStateStore(statePath);
  const commands = new RunCommandService(registry, workspaces);
  const jobs = new JobManager(commands);
  const browser = new PlaywrightCliService({
    ...process.env,
    PATH: "",
    JUNIUS_PLAYWRIGHT_CLI_PATH: undefined,
    PLAYWRIGHT_CLI_HOME: undefined,
    JUNIUS_BROWSER_STATE_PATH: join(root, "browser"),
  });

  let origin = "";
  const server = createServer((req, res) => {
    void handleAdminRequest(
      req,
      res,
      registry,
      machineCapabilities,
      workspaces,
      store,
      jobs,
      browser,
      origin,
    );
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;

  return {
    root,
    origin,
    async dispose() {
      server.close();
      await once(server, "close");
      await jobs.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("admin server serves the local WebUI and runtime state", async () => {
  const f = await fixture();
  try {
    const page = await fetch(f.origin + "/");
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get("content-type") ?? "",
      /^text\/html/u,
    );
    assert.match(await page.text(), /Junius Dashboard/u);

    const state = await fetch(f.origin + "/state");
    assert.equal(state.status, 200);

    const body = await state.json() as {
      registeredCapabilities: { key: string }[];
      machineCapabilities: {
        key: string;
        enabled: boolean;
        available: boolean;
        active: boolean;
      }[];
      workspaces: unknown[];
      jobs: unknown[];
      browser: { available: boolean; statePath: string };
    };

    assert.deepEqual(
      body.registeredCapabilities.map((capability) => capability.key),
      ["node"],
    );
    assert.deepEqual(
      body.machineCapabilities.map((capability) => ({
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
          available: false,
          active: false,
        },
      ],
    );
    assert.deepEqual(body.workspaces, []);
    assert.deepEqual(body.jobs, []);
    assert.equal(body.browser.available, false);
    assert.equal(body.browser.statePath, join(f.root, "browser"));
  } finally {
    await f.dispose();
  }
});

test("admin WebUI backend keeps Workspace mutation API working", async () => {
  const f = await fixture();
  try {
    const workspaceRoot = join(f.root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(workspaceRoot, { recursive: true }),
    );

    const created = await fetch(f.origin + "/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "demo",
        rootPath: workspaceRoot,
      }),
    });

    assert.equal(created.status, 201);

    const state = await fetch(f.origin + "/api/state");
    const body = await state.json() as {
      workspaces: { id: string; rootPath: string }[];
    };

    assert.equal(body.workspaces.length, 1);
    assert.equal(body.workspaces[0]?.id, "demo");
  } finally {
    await f.dispose();
  }
});


test("admin WebUI backend can persistently disable a machine capability", async () => {
  const f = await fixture();
  try {
    const disabled = await fetch(f.origin + "/capabilities/node", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ enabled: false }),
    });

    assert.equal(disabled.status, 200);

    const state = await fetch(f.origin + "/state");
    const body = await state.json() as {
      registeredCapabilities: { key: string }[];
      machineCapabilities: {
        key: string;
        enabled: boolean;
        active: boolean;
      }[];
    };

    assert.deepEqual(body.registeredCapabilities, []);
    assert.deepEqual(
      body.machineCapabilities.map((capability) => ({
        key: capability.key,
        enabled: capability.enabled,
        active: capability.active,
      })),
      [
        { key: "node", enabled: false, active: false },
        { key: "pnpm", enabled: true, active: false },
      ],
    );
  } finally {
    await f.dispose();
  }
});
