import {
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { ComputerSessionManager, closeComputerSessions } from "./mcp-computer-sessions.js";
import { createMcpServer } from "./mcp-server.js";
import { RunCommandService } from "./run-command.js";
import { WorkspaceFilesService } from "./workspace-files.js";
import type { WorkspaceRegistryService } from "./workspace-registry.js";
import { JobManager } from "./job-manager.js";
import { PlaywrightCliService } from "./playwright-cli.js";
import { DesktopComputerUseService } from "./desktop-computer-use.js";
import type { AuditStore } from "./audit-store.js";
import type { McpObservabilityStore } from "./mcp-observability.js";
import {
  withMcpSessionContext,
} from "./mcp-session-context.js";

export interface McpRuntime {
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export async function createMcpRuntime(
  commands: RunCommandService,
  workspaces: WorkspaceRegistryService,
  files: WorkspaceFilesService,
  jobs: JobManager,
  playwrightCli: PlaywrightCliService,
  desktop: DesktopComputerUseService,
  audit?: AuditStore,
  observability?: McpObservabilityStore,
  sessions = new ComputerSessionManager(),
): Promise<McpRuntime> {
  const modernHandler = createMcpHandler(
    () => createMcpServer(
      commands,
      workspaces,
      files,
      jobs,
      playwrightCli,
      desktop,
      audit,
      observability,
      sessions,
    ),
    {
    legacy: "reject",
    onerror(error) {
      console.error("[mcp modern]", error);
    },
    },
  );

  const legacyServer =
    createMcpServer(
      commands,
      workspaces,
      files,
      jobs,
      playwrightCli,
      desktop,
      audit,
      observability,
      sessions,
    );
  const legacyTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
  });

  await legacyServer.connect(legacyTransport);

  return {
    async handle(request) {
      const requestSessionId =
        request.headers.get(
          "mcp-session-id",
        ) ?? undefined;

      if (
        requestSessionId !==
          undefined &&
        request.method !==
          "DELETE"
      ) {
        observability?.ensureSession(
          requestSessionId,
        );
      }

      return withMcpSessionContext(
        requestSessionId,
        async () => {
          const response =
            (await isLegacyRequest(
              request,
            ))
              ? await legacyTransport
                  .handleRequest(
                    request,
                  )
              : await modernHandler
                  .fetch(request);

          const responseSessionId =
            response.headers.get(
              "mcp-session-id",
            ) ?? undefined;

          if (
            responseSessionId !==
            undefined
          ) {
            observability?.ensureSession(
              responseSessionId,
            );
          }

          if (
            request.method ===
              "DELETE" &&
            requestSessionId !==
              undefined &&
            response.ok
          ) {
            await closeComputerSessions(
              sessions.endChat(requestSessionId),
              playwrightCli,
              desktop,
            );
            observability?.deleteSession(
              requestSessionId,
            );
          }

          return response;
        },
      );
    },

    async close() {
      await Promise.allSettled([
        modernHandler.close(),
        legacyServer.close(),
      ]);
    },
  };
}
