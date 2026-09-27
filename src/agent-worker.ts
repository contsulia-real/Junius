import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  createServer as createHttpServer,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { handleAdminRequest } from "./admin-server.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import type { RuntimeConfig } from "./config.js";
import {
  sendJson,
  toWebRequest,
  writeWebResponse,
} from "./http-bridge.js";
import { JobManager } from "./job-manager.js";
import { MachineCapabilityStateStore } from "./machine-capability-state-store.js";
import { MachineCapabilityManager } from "./machine-capabilities.js";
import { createMcpRuntime } from "./mcp-runtime.js";
import { PlaywrightCliService } from "./playwright-cli.js";
import { RunCommandService } from "./run-command.js";
import { DesktopComputerUseService } from "./desktop-computer-use.js";
import { WorkspaceFilesService } from "./workspace-files.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";
import { WorkspaceStateStore } from "./workspace-state-store.js";

export interface AgentWorkerOptions {
  readonly config: RuntimeConfig;
  readonly workerId: string;
  readonly mcpListenPort?: number;
  readonly adminListenPort?: number;
  readonly publicMcpOrigin?: string;
  readonly publicAdminOrigin?: string;
}

export interface AgentWorkerHandle {
  readonly workerId: string;
  readonly mcpPort: number;
  readonly adminPort: number;
  readonly publicMcpOrigin: string;
  readonly publicAdminOrigin: string;
  close(): Promise<void>;
}

async function listen(
  server: Server,
  port: number,
  host: string,
): Promise<number> {
  server.listen(port, host);
  await once(server, "listening");

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("worker_listener_address_unavailable");
  }

  return (address as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;

  server.close();
  await once(server, "close");
}

export async function startAgentWorker(
  options: AgentWorkerOptions,
): Promise<AgentWorkerHandle> {
  const { config, workerId } = options;
  const publicMcpOrigin =
    options.publicMcpOrigin ??
    `http://${config.mcpHost}:${config.mcpPort}`;
  const publicAdminOrigin =
    options.publicAdminOrigin ??
    `http://${config.adminHost}:${config.adminPort}`;

  const registry = new CapabilityRegistry();
  const browser = new PlaywrightCliService();
  const desktop = new DesktopComputerUseService();

  const machineCapabilityStateStore = new MachineCapabilityStateStore(
    config.machineCapabilityStatePath,
  );
  const machineCapabilities = await MachineCapabilityManager.create(
    registry,
    machineCapabilityStateStore,
    { browser, desktop },
  );

  const workspaceStateStore = new WorkspaceStateStore(
    config.workspaceStatePath,
  );
  const persistedWorkspaces = await workspaceStateStore.load();

  let workspaces: WorkspaceManager;

  if (persistedWorkspaces === undefined) {
    const initialWorkspaceProfile = new WorkspaceProfile(
      config.workspaceRoot,
      [
        {
          key: "node",
          arguments: [
            { mode: "exact", args: ["--version"] },
            { mode: "exact", args: ["-p", "process.platform"] },
          ],
        },
      ],
    );

    workspaces = new WorkspaceManager([
      {
        id: config.workspaceId,
        profile: initialWorkspaceProfile,
      },
    ]);

    await workspaceStateStore.save(workspaces);
  } else {
    workspaces = new WorkspaceManager(
      persistedWorkspaces.map((workspace) => ({
        id: workspace.id,
        profile: new WorkspaceProfile(
          workspace.rootPath,
          workspace.grants,
        ),
      })),
    );
  }

  const commands = new RunCommandService(registry, workspaces);
  const files = new WorkspaceFilesService(workspaces);
  const jobs = new JobManager(commands);
  const mcpRuntime = await createMcpRuntime(
    commands,
    files,
    jobs,
    browser,
    desktop,
  );
  const adminToken = randomBytes(32).toString("base64url");

  const mcpHttpServer = createHttpServer((req, res) => {
    void (async () => {
      const request = toWebRequest(req, publicMcpOrigin);
      const url = new URL(request.url);

      if (url.pathname !== "/mcp") {
        sendJson(res, 404, { error: "not_found" });
        return;
      }

      const response = await mcpRuntime.handle(request);
      await writeWebResponse(res, response);
    })().catch((error: unknown) => {
      console.error(`[worker ${workerId} mcp]`, error);

      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error" });
        return;
      }

      res.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });

  const adminHttpServer = createHttpServer((req, res) => {
    if (req.url === "/__junius/worker-health") {
      sendJson(res, 200, {
        ok: true,
        workerId,
        pid: process.pid,
      });
      return;
    }

    void handleAdminRequest(
      req,
      res,
      registry,
      machineCapabilities,
      workspaces,
      workspaceStateStore,
      jobs,
      browser,
      desktop,
      publicAdminOrigin,
      adminToken,
    ).catch((error: unknown) => {
      console.error(`[worker ${workerId} admin]`, error);

      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error" });
        return;
      }

      res.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });

  let mcpPort: number | undefined;
  let adminPort: number | undefined;

  try {
    mcpPort = await listen(
      mcpHttpServer,
      options.mcpListenPort ?? 0,
      config.mcpHost,
    );
    adminPort = await listen(
      adminHttpServer,
      options.adminListenPort ?? 0,
      config.adminHost,
    );
  } catch (error) {
    await Promise.allSettled([
      closeServer(mcpHttpServer),
      closeServer(adminHttpServer),
      mcpRuntime.close(),
      jobs.close(),
    ]);
    throw error;
  }

  let closed = false;

  return {
    workerId,
    mcpPort,
    adminPort,
    publicMcpOrigin,
    publicAdminOrigin,
    async close() {
      if (closed) return;
      closed = true;

      await Promise.allSettled([
        closeServer(mcpHttpServer),
        closeServer(adminHttpServer),
        mcpRuntime.close(),
        jobs.close(),
        desktop.close(),
      ]);
    },
  };
}
