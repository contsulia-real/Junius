import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AuditStore,
  resolveAuditPath,
  resolveAuditRetention,
} from "./audit-store.js";
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
import { createMcpRuntime } from "./mcp-runtime.js";
import { ComputerSessionManager } from "./mcp-computer-sessions.js";
import { McpObservabilityStore } from "./mcp-observability.js";
import {
  resolveMcpObservabilitySessionsPath,
} from "./mcp-observability-persistence.js";
import {
  PlaywrightCliService,
  resolveBrowserStatePath,
} from "./playwright-cli.js";
import { RunCommandService } from "./run-command.js";
import { DesktopComputerUseService } from "./desktop-computer-use.js";
import { EscapeInterruptService } from "./user-interrupt.js";
import { WorkspaceFilesService } from "./workspace-files.js";
import { WorkspaceRegistryService } from "./workspace-registry.js";
import { createAgentWorkerWorkspaceRuntime } from "./agent-worker-workspaces.js";
import { createAgentWorkerHttpServers } from "./agent-worker-http.js";

export interface AgentWorkerOptions {
  readonly config:
    RuntimeConfig;
  readonly workerId:
    string;
  readonly mcpListenPort?:
    number;
  readonly controlListenPort?:
    number;
  readonly publicMcpOrigin?:
    string;
  readonly internalToken:
    string;
  readonly onJobTerminal?:
    (job: JobSnapshot) => void;
  readonly onJobHistoryPersisted?:
    (job: JobSnapshot) => void;
}

export interface AgentWorkerHandle {
  readonly workerId: string;
  readonly mcpPort: number;
  readonly controlPort: number;
  readonly publicMcpOrigin:
    string;
  reloadConfiguration():
    Promise<void>;
  close(): Promise<void>;
}

async function listen(
  server: Server,
  port: number,
  host: string,
): Promise<number> {
  server.listen(
    port,
    host,
  );
  await once(
    server,
    "listening",
  );

  const address =
    server.address();
  if (
    address === null ||
    typeof address ===
      "string"
  ) {
    throw new Error(
      "worker_listener_address_unavailable",
    );
  }

  return (
    address as AddressInfo
  ).port;
}

async function closeServer(
  server: Server,
): Promise<void> {
  if (!server.listening) {
    return;
  }

  server.close();
  await once(
    server,
    "close",
  );
}

export async function startAgentWorker(
  options:
    AgentWorkerOptions,
): Promise<AgentWorkerHandle> {
  const {
    config,
    workerId,
    internalToken,
  } = options;

  if (
    internalToken.length < 32
  ) {
    throw new Error(
      "worker_internal_token_invalid",
    );
  }

  const publicMcpOrigin =
    options.publicMcpOrigin ??
    `http://${config.mcpHost}:${config.mcpPort}`;

  const audit =
    new AuditStore(
      resolveAuditPath(),
      resolveAuditRetention(),
    );
  const observability =
    new McpObservabilityStore({
      rootPath:
        resolveMcpObservabilitySessionsPath(),
    });
  const interrupt =
    new EscapeInterruptService();
  const browser =
    new PlaywrightCliService(
      process.env,
      undefined,
      { interrupt },
    );
  const desktop =
    new DesktopComputerUseService();
  const sessions = new ComputerSessionManager();

  const workspaceRuntime =
    await createAgentWorkerWorkspaceRuntime(
      config,
    );
  const {
    workspaces,
    stateStore:
      workspaceStateStore,
    reloadConfiguration,
  } = workspaceRuntime;

  const commands =
    new RunCommandService(
      workspaces,
      audit,
    );
  const workspaceRegistry =
    new WorkspaceRegistryService(
      workspaces,
      workspaceStateStore,
      audit,
    );
  const files =
    new WorkspaceFilesService(
      workspaces,
      [
        resolveJuniusRuntimeRoot(),
        config.workspaceStatePath,
        resolveBrowserStatePath(),
        audit.rootPath,
      ],
      audit,
    );
  const jobs =
    new JobManager(
      commands,
      options.onJobTerminal,
      new JobHistoryStore(
        resolveJobHistoryPath(),
        resolveJobHistoryRetention(),
      ),
      options
        .onJobHistoryPersisted,
      audit,
      workerId,
    );
  const mcpRuntime =
    await createMcpRuntime(
      commands,
      workspaceRegistry,
      files,
      jobs,
      browser,
      desktop,
      audit,
      observability,
      sessions,
    );

  const {
    mcpHttpServer,
    controlHttpServer,
  } =
    createAgentWorkerHttpServers({
      workerId,
      internalToken,
      publicMcpOrigin,
      mcpRuntime,
      reloadConfiguration,
    });

  let mcpPort:
    number | undefined;
  let controlPort:
    number | undefined;

  try {
    mcpPort =
      await listen(
        mcpHttpServer,
        options
          .mcpListenPort ??
          0,
        config.mcpHost,
      );
    controlPort =
      await listen(
        controlHttpServer,
        options
          .controlListenPort ??
          0,
        config.controlHost,
      );
  } catch (error) {
    await Promise.allSettled([
      closeServer(
        mcpHttpServer,
      ),
      closeServer(
        controlHttpServer,
      ),
      mcpRuntime.close(),
      jobs.close(),
    ]);
    throw error;
  }

  let closed = false;

  return {
    workerId,
    mcpPort,
    controlPort,
    publicMcpOrigin,
    reloadConfiguration,
    async close() {
      if (closed) return;
      closed = true;

      await Promise.allSettled([
        closeServer(
          mcpHttpServer,
        ),
        closeServer(
          controlHttpServer,
        ),
        mcpRuntime.close(),
        jobs.close(),
        browser.close(),
        desktop.close(),
        interrupt.close(),
        audit.close(),
      ]);
    },
  };
}
