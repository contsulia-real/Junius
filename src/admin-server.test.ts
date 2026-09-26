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
import { ProcessCapability } from "./capabilities/process-capability.js";
import { JobManager } from "./job-manager.js";
import { PlaywrightCliService } from "./playwright-cli.js";
import { RunCommandService } from "./run-command.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceStateStore } from "./workspace-state-store.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "junius-admin-"));
  const statePath = join(root, "workspace-state.json");
  const registry = new CapabilityRegistry();

  registry.register(
    new ProcessCapability({
      key: "node",
      description: "test node capability",
      executable: process.execPath,
      allowedArgVectors: [["--version"]],
    }),
  );

  const workspaces = new WorkspaceManager();
  const store = new WorkspaceStateStore(statePath);
  const commands = new RunCommandService(registry, workspaces);
  const jobs = new JobManager(commands);
  const browser = new PlaywrightCliService({
    ...process.env,
    PATH: "",
    JUNIUS_BROWSER_STATE_PATH: join(root, "browser"),
  });

  let origin = "";
  const server = createServer((req, res) => {
    void handleAdminRequest(
      req,
      res,
      registry,
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
      workspaces: unknown[];
      jobs: unknown[];
      browser: { available: boolean; statePath: string };
    };

    assert.deepEqual(
      body.registeredCapabilities.map((capability) => capability.key),
      ["node"],
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
