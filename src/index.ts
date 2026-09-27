import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { handleAdminRequest } from "./admin-server.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { loadRuntimeConfig } from "./config.js";
import {
  sendJson,
  toWebRequest,
  writeWebResponse,
} from "./http-bridge.js";
import { createMcpRuntime } from "./mcp-runtime.js";
import { RunCommandService } from "./run-command.js";
import {
  JobHistoryStore,
  resolveJobHistoryPath,
} from "./job-history-store.js";
import { JobManager } from "./job-manager.js";
import { MachineCapabilityStateStore } from "./machine-capability-state-store.js";
import { MachineCapabilityManager } from "./machine-capabilities.js";
import { PlaywrightCliService } from "./playwright-cli.js";
import { DesktopComputerUseService } from "./desktop-computer-use.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceFilesService } from "./workspace-files.js";
import { WorkspaceProfile } from "./workspace-profile.js";
import { WorkspaceStateStore } from "./workspace-state-store.js";

const config = await loadRuntimeConfig();
const registry = new CapabilityRegistry();

const playwrightCliService = new PlaywrightCliService();
const desktopComputerUseService = new DesktopComputerUseService();

const machineCapabilityStateStore = new MachineCapabilityStateStore(
  config.machineCapabilityStatePath,
);
const machineCapabilityManager = await MachineCapabilityManager.create(
  registry,
  machineCapabilityStateStore,
  {
    browser: playwrightCliService,
    desktop: desktopComputerUseService,
  },
);

const workspaceStateStore = new WorkspaceStateStore(
  config.workspaceStatePath,
);
const persistedWorkspaces = await workspaceStateStore.load();

let workspaceManager: WorkspaceManager;

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

  workspaceManager = new WorkspaceManager([
    {
      id: config.workspaceId,
      profile: initialWorkspaceProfile,
    },
  ]);

  await workspaceStateStore.save(workspaceManager);
} else {
  workspaceManager = new WorkspaceManager(
    persistedWorkspaces.map((workspace) => ({
      id: workspace.id,
      profile: new WorkspaceProfile(
        workspace.rootPath,
        workspace.grants,
      ),
    })),
  );
}

const runCommandService = new RunCommandService(registry, workspaceManager);
const workspaceFilesService = new WorkspaceFilesService(workspaceManager);
const jobManager = new JobManager(
  runCommandService,
  undefined,
  new JobHistoryStore(
    resolveJobHistoryPath(),
  ),
);
const mcpRuntime = await createMcpRuntime(
  runCommandService,
  workspaceFilesService,
  jobManager,
  playwrightCliService,
  desktopComputerUseService,
);

const mcpOrigin = `http://${config.mcpHost}:${config.mcpPort}`;
const adminOrigin = `http://${config.adminHost}:${config.adminPort}`;
const adminToken = randomBytes(32).toString("base64url");

const mcpHttpServer = createHttpServer((req, res) => {
  void (async () => {
    const request = toWebRequest(req, mcpOrigin);
    const url = new URL(request.url);

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const response = await mcpRuntime.handle(request);
    await writeWebResponse(res, response);
  })().catch((error: unknown) => {
    console.error("[mcp http]", error);

    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal_error" });
      return;
    }

    res.destroy(error instanceof Error ? error : new Error(String(error)));
  });
});

const adminHttpServer = createHttpServer((req, res) => {
  void handleAdminRequest(
    req,
    res,
    registry,
    machineCapabilityManager,
    workspaceManager,
    workspaceStateStore,
    jobManager,
    playwrightCliService,
    desktopComputerUseService,
    adminOrigin,
    adminToken,
  ).catch((error: unknown) => {
    console.error("[admin http]", error);

    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal_error" });
      return;
    }

    res.destroy(error instanceof Error ? error : new Error(String(error)));
  });
});

mcpHttpServer.listen(config.mcpPort, config.mcpHost, () => {
  console.error(`Junius MCP: ${mcpOrigin}/mcp`);
});

adminHttpServer.listen(config.adminPort, config.adminHost, () => {
  console.error(`Junius WebUI: ${adminOrigin}/`);
  console.error(
    `Junius Workspace state: ${config.workspaceStatePath}`,
  );
  console.error(
    `Junius machine capability state: ${config.machineCapabilityStatePath}`,
  );
  console.error(
    `Junius Workspaces loaded: ${workspaceManager.list().length}`,
  );
});

async function shutdown(signal: string): Promise<void> {
  console.error(`Received ${signal}; shutting down Junius.`);

  mcpHttpServer.close();
  adminHttpServer.close();
  await mcpRuntime.close();
  await jobManager.close();
  await playwrightCliService.close();
  await desktopComputerUseService.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => {
      process.exit(0);
    });
  });
}
