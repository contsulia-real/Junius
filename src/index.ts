import { createServer as createHttpServer } from "node:http";
import { handleAdminRequest } from "./admin-server.js";
import { createDefaultCapabilityRegistry } from "./capabilities/default-registry.js";
import { loadRuntimeConfig } from "./config.js";
import {
  sendJson,
  toWebRequest,
  writeWebResponse,
} from "./http-bridge.js";
import { createMcpRuntime } from "./mcp-runtime.js";
import { RunCommandService } from "./run-command.js";
import { WorkspaceProfile } from "./workspace-profile.js";

const config = await loadRuntimeConfig();
const registry = createDefaultCapabilityRegistry();
const workspaceProfile = new WorkspaceProfile(config.workspaceRoot, [
  {
    key: "node",
    arguments: [
      { mode: "exact", args: ["--version"] },
      { mode: "exact", args: ["-p", "process.platform"] },
    ],
  },
]);
const runCommandService = new RunCommandService(registry, workspaceProfile);
const mcpRuntime = await createMcpRuntime(runCommandService);

const mcpOrigin = `http://${config.mcpHost}:${config.mcpPort}`;
const adminOrigin = `http://${config.adminHost}:${config.adminPort}`;

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
    workspaceProfile,
    adminOrigin,
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
  console.error(`Junius local admin: ${adminOrigin}/state`);
  console.error(`Junius workspace root: ${config.workspaceRoot}`);
});

async function shutdown(signal: string): Promise<void> {
  console.error(`Received ${signal}; shutting down Junius.`);

  mcpHttpServer.close();
  adminHttpServer.close();
  await mcpRuntime.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => {
      process.exit(0);
    });
  });
}
