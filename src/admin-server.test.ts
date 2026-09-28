import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleAdminRequest } from "./admin-server.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { DesktopComputerUseService } from "./desktop-computer-use.js";
import { JobHistoryStore } from "./job-history-store.js";
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

  const browser = new PlaywrightCliService({
    ...process.env,
    PATH: "",
    JUNIUS_BROWSER_STATE_PATH: join(root, "browser"),
  });
  const desktop = new DesktopComputerUseService({
    helperPath: join(root, "missing-desktop-helper.py"),
    pythonExecutable: join(root, "missing-python.exe"),
    platform: "win32",
  });

  const machineStore = new MachineCapabilityStateStore(
    join(root, "machine-capability-state.json"),
  );
  const machineCapabilities = await MachineCapabilityManager.create(
    registry,
    machineStore,
    { browser, desktop },
    {
      ...process.env,
      PATH: "",
    },
    process.execPath,
  );

  const workspaces = new WorkspaceManager();
  const store = new WorkspaceStateStore(statePath);
  const commands = new RunCommandService(registry, workspaces);
  const jobs = new JobManager(
    commands,
    undefined,
    new JobHistoryStore(
      join(root, "job-history"),
      { maxEntries: 25 },
    ),
  );

  let origin = "";
  const adminToken = "test-admin-token";
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
      desktop,
      origin,
      adminToken,
    );
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;

  return {
    root,
    origin,
    workspaces,
    mutationHeaders(json = true) {
      return {
        ...(json ? { "content-type": "application/json" } : {}),
        "x-junius-admin-token": adminToken,
        origin,
      };
    },
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
    assert.match(await page.text(), /Junius 控制台/u);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.match(
      page.headers.get("content-security-policy") ?? "",
      /frame-ancestors 'none'/u,
    );

    const state = await fetch(f.origin + "/state");
    assert.equal(state.status, 200);
    assert.equal(state.headers.get("cache-control"), "no-store");
    assert.equal(state.headers.get("x-content-type-options"), "nosniff");

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
      jobHistory: {
        entries: number;
        capturedBytes: number;
        retention: {
          maxEntries?: number;
          maxAgeMs?: number;
        };
      };
      adminToken: string;
      browser: {
        enabled: boolean;
        available: boolean;
        active: boolean;
        statePath: string;
      };
      desktop: {
        enabled: boolean;
        available: boolean;
        active: boolean;
        helperPath: string;
        pythonExecutable?: string;
      };
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
        {
          key: "git",
          enabled: true,
          available: false,
          active: false,
        },
        {
          key: "browser",
          enabled: true,
          available: false,
          active: false,
        },
        {
          key: "desktop",
          enabled: true,
          available: false,
          active: false,
        },
      ],
    );
    assert.deepEqual(body.workspaces, []);
    assert.deepEqual(body.jobs, []);
    assert.equal(body.jobHistory.entries, 0);
    assert.equal(body.jobHistory.capturedBytes, 0);
    assert.deepEqual(body.jobHistory.retention, {
      maxEntries: 25,
    });
    assert.equal(body.adminToken, "test-admin-token");
    assert.equal(body.browser.enabled, true);
    assert.equal(body.browser.available, false);
    assert.equal(body.browser.active, false);
    assert.equal(body.browser.statePath, join(f.root, "browser"));
    assert.equal(body.desktop.enabled, true);
    assert.equal(body.desktop.available, false);
    assert.equal(body.desktop.active, false);
    assert.match(
      body.desktop.helperPath,
      /missing-desktop-helper\.py$/u,
    );
    assert.equal(body.desktop.pythonExecutable, undefined);
    assert.equal(body.desktop.available, false);
    assert.equal(
      body.desktop.helperPath,
      join(f.root, "missing-desktop-helper.py"),
    );
  } finally {
    await f.dispose();
  }
});

test("admin Workspace API creates workspaces and preserves exact/prefix grant semantics", async () => {
  const f = await fixture();
  try {
    const workspaceRoot = join(
      f.root,
      "workspace-auth",
    );
    await import("node:fs/promises").then(
      ({ mkdir }) =>
        mkdir(workspaceRoot, {
          recursive: true,
        }),
    );

    const created = await fetch(
      f.origin + "/workspaces",
      {
        method: "POST",
        headers: f.mutationHeaders(),
        body: JSON.stringify({
          id: "demo",
          rootPath: workspaceRoot,
        }),
      },
    );
    assert.equal(created.status, 201);

    const grant = await fetch(
      f.origin +
        "/workspaces/demo/grants/node",
      {
        method: "POST",
        headers: f.mutationHeaders(),
        body: JSON.stringify({
          arguments: [
            {
              mode: "exact",
              args: ["--version"],
            },
            {
              mode: "prefix",
              args: ["-p"],
            },
          ],
        }),
      },
    );
    assert.equal(grant.status, 200);

    const state = await fetch(
      f.origin + "/api/state",
    );
    const body = await state.json() as {
      workspaces: {
        id: string;
        rootPath: string;
        grants: {
          key: string;
          arguments: {
            mode: "exact" | "prefix";
            args: string[];
            valid: boolean;
          }[];
        }[];
      }[];
    };

    assert.equal(body.workspaces.length, 1);
    assert.equal(
      body.workspaces[0]?.id,
      "demo",
    );
    assert.equal(
      body.workspaces[0]?.rootPath,
      workspaceRoot,
    );
    assert.deepEqual(
      body.workspaces[0]?.grants,
      [
        {
          key: "node",
          arguments: [
            {
              mode: "exact",
              args: ["--version"],
              valid: true,
            },
            {
              mode: "prefix",
              args: ["-p"],
              valid: true,
            },
          ],
        },
      ],
    );
  } finally {
    await f.dispose();
  }
});

test("admin capability disable unregisters the capability without rewriting Workspace grants", async () => {
  const f = await fixture();
  try {
    const workspaceRoot = join(
      f.root,
      "workspace-grant",
    );
    await import("node:fs/promises").then(
      ({ mkdir }) =>
        mkdir(workspaceRoot, {
          recursive: true,
        }),
    );

    assert.equal(
      (
        await fetch(
          f.origin + "/workspaces",
          {
            method: "POST",
            headers: f.mutationHeaders(),
            body: JSON.stringify({
              id: "demo",
              rootPath: workspaceRoot,
            }),
          },
        )
      ).status,
      201,
    );

    assert.equal(
      (
        await fetch(
          f.origin +
            "/workspaces/demo/grants/node",
          {
            method: "POST",
            headers: f.mutationHeaders(),
            body: JSON.stringify({
              arguments: [
                {
                  mode: "exact",
                  args: ["--version"],
                },
              ],
            }),
          },
        )
      ).status,
      200,
    );

    const disabled = await fetch(
      f.origin + "/capabilities/node",
      {
        method: "POST",
        headers: f.mutationHeaders(),
        body: JSON.stringify({
          enabled: false,
        }),
      },
    );
    assert.equal(disabled.status, 200);

    const state = await fetch(
      f.origin + "/state",
    );
    const body = await state.json() as {
      registeredCapabilities: {
        key: string;
      }[];
      machineCapabilities: {
        key: string;
        enabled: boolean;
        active: boolean;
      }[];
      workspaces: {
        id: string;
        grants: {
          key: string;
          arguments: {
            mode: string;
            args: string[];
            valid: boolean;
          }[];
        }[];
      }[];
    };

    assert.equal(
      body.registeredCapabilities.some(
        (capability) =>
          capability.key === "node",
      ),
      false,
    );
    const node =
      body.machineCapabilities.find(
        (capability) =>
          capability.key === "node",
      );
    assert.equal(node?.enabled, false);
    assert.equal(node?.active, false);
    assert.deepEqual(
      body.workspaces[0]?.grants,
      [
        {
          key: "node",
          arguments: [
            {
              mode: "exact",
              args: ["--version"],
              valid: true,
            },
          ],
        },
      ],
    );
  } finally {
    await f.dispose();
  }
});

test("admin API state omits the mutation token", async () => {
  const f = await fixture();
  try {
    const response = await fetch(f.origin + "/api/state");
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal("adminToken" in body, false);
  } finally {
    await f.dispose();
  }
});

test("admin rejects hostile Host headers even for reads", async () => {
  const f = await fixture();
  try {
    const result = await new Promise<{
      statusCode?: number;
      body: string;
    }>((resolvePromise, reject) => {
      const req = request(
        f.origin + "/state",
        {
          method: "GET",
          headers: {
            host: "example.invalid",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer | string) => {
            chunks.push(
              Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk),
            );
          });
          res.once("end", () => {
            resolvePromise({
              statusCode: res.statusCode,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.once("error", reject);
      req.end();
    });

    assert.equal(result.statusCode, 403);
    assert.equal(
      (JSON.parse(result.body) as { error: string }).error,
      "admin_host_not_allowed",
    );
  } finally {
    await f.dispose();
  }
});

test("admin mutation API requires its local token and JSON bodies", async () => {
  const f = await fixture();
  try {
    const noToken = await fetch(f.origin + "/capabilities/node", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: f.origin,
      },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(noToken.status, 403);
    assert.equal(
      (await noToken.json() as { error: string }).error,
      "admin_token_required",
    );

    const wrongOrigin = await fetch(f.origin + "/capabilities/node", {
      method: "POST",
      headers: {
        ...f.mutationHeaders(),
        origin: "https://example.invalid",
      },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(wrongOrigin.status, 403);
    assert.equal(
      (await wrongOrigin.json() as { error: string }).error,
      "admin_origin_not_allowed",
    );

    const textBody = await fetch(f.origin + "/capabilities/node", {
      method: "POST",
      headers: {
        ...f.mutationHeaders(false),
        "content-type": "text/plain",
      },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(textBody.status, 400);
    assert.equal(
      (await textBody.json() as { error: string }).error,
      "application_json_required",
    );
  } finally {
    await f.dispose();
  }
});

test("Workspace grant API rejects rules outside machine policy", async () => {
  const f = await fixture();
  try {
    const workspaceRoot = join(f.root, "workspace-invalid-grant");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(workspaceRoot, { recursive: true }),
    );

    assert.equal(
      (
        await fetch(f.origin + "/workspaces", {
          method: "POST",
          headers: f.mutationHeaders(),
          body: JSON.stringify({
            id: "invalid-grant",
            rootPath: workspaceRoot,
          }),
        })
      ).status,
      201,
    );

    const response = await fetch(
      f.origin + "/workspaces/invalid-grant/grants/pnpm",
      {
        method: "POST",
        headers: f.mutationHeaders(),
        body: JSON.stringify({
          arguments: [
            { mode: "exact", args: ["exec", "powershell"] },
          ],
        }),
      },
    );

    assert.equal(response.status, 400);
    assert.equal(
      (await response.json() as { error: string }).error,
      "arguments_outside_machine_policy",
    );
  } finally {
    await f.dispose();
  }
});

test("admin state preserves and marks historical invalid Workspace grants", async () => {
  const f = await fixture();
  try {
    const workspaceRoot = join(f.root, "workspace-historical-grant");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(workspaceRoot, { recursive: true }),
    );
    const profile = await f.workspaces.register(
      "historical",
      workspaceRoot,
    );
    profile.setGrant({
      key: "pnpm",
      arguments: [
        { mode: "exact", args: ["exec", "powershell"] },
      ],
    });

    const state = await fetch(f.origin + "/state");
    const body = await state.json() as {
      workspaces: {
        id: string;
        grants: {
          key: string;
          arguments: {
            mode: string;
            args: string[];
            valid: boolean;
            reason?: string;
          }[];
        }[];
      }[];
    };

    const workspace = body.workspaces.find(
      (item) => item.id === "historical",
    );
    assert.deepEqual(workspace?.grants, [
      {
        key: "pnpm",
        arguments: [
          {
            mode: "exact",
            args: ["exec", "powershell"],
            valid: false,
            reason: "arguments_outside_machine_policy",
          },
        ],
      },
    ]);

    const preserveWhileEditing = await fetch(
      f.origin + "/workspaces/historical/grants/pnpm",
      {
        method: "POST",
        headers: f.mutationHeaders(),
        body: JSON.stringify({
          arguments: [
            { mode: "exact", args: ["exec", "powershell"] },
            { mode: "exact", args: ["run", "check"] },
          ],
        }),
      },
    );
    assert.equal(preserveWhileEditing.status, 200);

    const removeHistoricalInvalid = await fetch(
      f.origin + "/workspaces/historical/grants/pnpm",
      {
        method: "POST",
        headers: f.mutationHeaders(),
        body: JSON.stringify({
          arguments: [
            { mode: "exact", args: ["run", "check"] },
          ],
        }),
      },
    );
    assert.equal(removeHistoricalInvalid.status, 200);
  } finally {
    await f.dispose();
  }
});

test("admin creates custom machine capabilities and preserves Workspace grants after deletion", async () => {
  const f = await fixture();

  try {
    const created = await fetch(
      f.origin + "/capabilities",
      {
        method: "POST",
        headers: f.mutationHeaders(),
        body: JSON.stringify({
          key: "custom_node",
          description: "Custom Node",
          executable: process.execPath,
          fixedArgs: [],
          argumentPolicy: [
            {
              mode: "exact",
              args: ["--version"],
            },
          ],
          timeoutMs: 10_000,
          maxOutputBytes: 65_536,
        }),
      },
    );
    assert.equal(created.status, 201);

    const workspace = await fetch(
      f.origin + "/workspaces",
      {
        method: "POST",
        headers: f.mutationHeaders(),
        body: JSON.stringify({
          id: "custom-test",
          rootPath: f.root,
        }),
      },
    );
    assert.equal(workspace.status, 201);

    const grant = await fetch(
      f.origin +
        "/workspaces/custom-test/grants/custom_node",
      {
        method: "POST",
        headers: f.mutationHeaders(),
        body: JSON.stringify({
          arguments: [
            {
              mode: "exact",
              args: ["--version"],
            },
          ],
        }),
      },
    );
    assert.equal(grant.status, 200);

    const beforeDelete = await fetch(
      f.origin + "/api/state",
    );
    const beforeBody = await beforeDelete.json() as {
      machineCapabilities: {
        key: string;
        custom: boolean;
      }[];
    };
    assert.equal(
      beforeBody.machineCapabilities.find(
        (capability) =>
          capability.key === "custom_node",
      )?.custom,
      true,
    );

    const removed = await fetch(
      f.origin + "/capabilities/custom_node",
      {
        method: "DELETE",
        headers: f.mutationHeaders(false),
      },
    );
    assert.equal(removed.status, 200);

    const state = await fetch(
      f.origin + "/api/state",
    );
    const body = await state.json() as {
      machineCapabilities: {
        key: string;
      }[];
      workspaces: {
        id: string;
        grants: {
          key: string;
          arguments: {
            valid: boolean;
            reason?: string;
          }[];
        }[];
      }[];
    };

    assert.equal(
      body.machineCapabilities.some(
        (capability) =>
          capability.key === "custom_node",
      ),
      false,
    );

    const preserved = body.workspaces
      .find(
        (item) =>
          item.id === "custom-test",
      )
      ?.grants.find(
        (item) =>
          item.key === "custom_node",
      )
      ?.arguments[0];

    assert.deepEqual(preserved, {
      mode: "exact",
      args: ["--version"],
      valid: false,
      reason:
        "machine_capability_not_known",
    });
  } finally {
    await f.dispose();
  }
});
