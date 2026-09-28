import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  AuditStore,
  resolveAuditPath,
  resolveAuditRetention,
} from "./audit-store.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CapabilityRegistry } from "./capabilities/registry.js";
import type { RuntimeConfig } from "./config.js";
import {
  JobHistoryStore,
  resolveJobHistoryPath,
  resolveJobHistoryRetention,
  resolveJuniusRuntimeRoot,
} from "./job-history-store.js";
import {
  JobManager,
  type JobSnapshot,
} from "./job-manager.js";
import { MachineCapabilityStateStore } from "./machine-capability-state-store.js";
import { MachineCapabilityManager } from "./machine-capabilities.js";
import { createMcpRuntime } from "./mcp-runtime.js";
import {
  PlaywrightCliService,
  resolveBrowserStatePath,
} from "./playwright-cli.js";
import { RunCommandService } from "./run-command.js";
import { DesktopComputerUseService } from "./desktop-computer-use.js";
import { WorkspaceFilesService } from "./workspace-files.js";
import { createAgentWorkerWorkspaceRuntime } from "./agent-worker-workspaces.js";
import { createAgentWorkerHttpServers } from "./agent-worker-http.js";

export interface AgentWorkerOptions {
  readonly config: RuntimeConfig;
  readonly workerId: string;
  readonly mcpListenPort?: number;
  readonly adminListenPort?: number;
  readonly publicMcpOrigin?: string;
  readonly publicAdminOrigin?: string;
  readonly internalToken: string;
  readonly onJobTerminal?: (job: JobSnapshot) => void;
  readonly onJobHistoryPersisted?: (job: JobSnapshot) => void;
}

export interface AgentWorkerHandle {
  readonly workerId: string;
  readonly mcpPort: number;
  readonly adminPort: number;
  readonly publicMcpOrigin: string;
  readonly publicAdminOrigin: string;
  reloadConfiguration(): Promise<void>;
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
  const {
    config,
    workerId,
    internalToken,
  } = options;
  if (internalToken.length < 32) {
    throw new Error(
      "worker_internal_token_invalid",
    );
  }

  const publicMcpOrigin =
    options.publicMcpOrigin ??
    `http://${config.mcpHost}:${config.mcpPort}`;
  const publicAdminOrigin =
    options.publicAdminOrigin ??
    `http://${config.adminHost}:${config.adminPort}`;

  const audit = new AuditStore(
    resolveAuditPath(),
    resolveAuditRetention(),
  );
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

  const workspaceRuntime =
    await createAgentWorkerWorkspaceRuntime(
      config,
      machineCapabilities,
    );
  const {
    workspaces,
    stateStore: workspaceStateStore,
    reloadConfiguration,
  } = workspaceRuntime;

  const commands = new RunCommandService(
    registry,
    workspaces,
    audit,
  );
  const files = new WorkspaceFilesService(
    workspaces,
    [
      resolveJuniusRuntimeRoot(),
      config.workspaceStatePath,
      config.machineCapabilityStatePath,
      resolveBrowserStatePath(),
      audit.rootPath,
    ],
    audit,
  );
  const jobs = new JobManager(
    commands,
    options.onJobTerminal,
    new JobHistoryStore(
      resolveJobHistoryPath(),
      resolveJobHistoryRetention(),
    ),
    options.onJobHistoryPersisted,
    audit,
    workerId,
  );
  const mcpRuntime = await createMcpRuntime(
    commands,
    files,
    jobs,
    browser,
    desktop,
    audit,
  );
  const adminToken = randomBytes(32).toString("base64url");

  const {
    mcpHttpServer,
    adminHttpServer,
  } = createAgentWorkerHttpServers({
    workerId,
    internalToken,
    publicMcpOrigin,
    publicAdminOrigin,
    adminToken,
    mcpRuntime,
    registry,
    machineCapabilities,
    workspaces,
    workspaceStateStore,
    jobs,
    browser,
    desktop,
    audit,
    reloadConfiguration,
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

  setImmediate(() => {
    if (closed) return;
    void Promise.allSettled([
      browser.prewarm(),
      desktop.prewarm(),
    ]);
  });

  return {
    workerId,
    mcpPort,
    adminPort,
    publicMcpOrigin,
    publicAdminOrigin,
    reloadConfiguration,
    async close() {
      if (closed) return;
      closed = true;

      await Promise.allSettled([
        closeServer(mcpHttpServer),
        closeServer(adminHttpServer),
        mcpRuntime.close(),
        jobs.close(),
        browser.close(),
        desktop.close(),
        audit.close(),
      ]);
    },
  };
}
