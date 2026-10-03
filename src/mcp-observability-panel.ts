import type {
  McpServer,
  ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  readFile,
} from "node:fs/promises";
import {
  fileURLToPath,
} from "node:url";
import type {
  AuditStore,
} from "./audit-store.js";
import {
  extractOpenAiRequestIdentity,
  type McpObservabilityStore,
} from "./mcp-observability.js";
import {
  JUNIUS_PANEL_SNAPSHOT_TOOL,
  JUNIUS_PANEL_TOOL,
  JUNIUS_TEST_WINDOW_CLOSE_TOOL,
} from "./mcp-observability-server.js";

export const PANEL_RESOURCE_URI =
  "ui://junius/observability-panel.html";

const MCP_APP_MIME_TYPE =
  "text/html;profile=mcp-app";

const PANEL_PATH =
  fileURLToPath(
    new URL(
      "../ui/observability-panel.html",
      import.meta.url,
    ),
  );

async function panelHtml():
  Promise<string> {
  return readFile(
    PANEL_PATH,
    "utf8",
  );
}

function panelToolMeta(): Record<string, unknown> {
  return {
    ui: {
      resourceUri:
        PANEL_RESOURCE_URI,
      visibility: [
        "model",
        "app",
      ],
    },
    "ui/resourceUri":
      PANEL_RESOURCE_URI,
    "openai/ui": {
      entrypoints: [
        {
          type:
            "thread",
        },
      ],
    },
    securitySchemes: [
      {
        type:
          "noauth",
      },
    ],
  };
}

function appOnlyToolMeta(): Record<string, unknown> {
  return {
    ui: {
      visibility: [
        "app",
      ],
    },
    securitySchemes: [
      {
        type:
          "noauth",
      },
    ],
  };
}

function modelOnlyToolMeta(): Record<string, unknown> {
  return {
    ui: {
      visibility: [
        "model",
      ],
    },
    securitySchemes: [
      {
        type:
          "noauth",
      },
    ],
  };
}

function panelSnapshot(
  observability:
    McpObservabilityStore,
  audit: AuditStore | undefined,
  context: ServerContext,
): Record<string, unknown> {
  const identity =
    extractOpenAiRequestIdentity(
      context.mcpReq._meta,
    );

  return {
    ...observability.snapshot(
      identity.sessionId,
    ),
    logs:
      audit === undefined
        ? []
        : audit.recent(256),
    panelRequestMetaKeys:
      identity.requestMetaKeys,
  };
}

export function registerMcpObservabilityPanel(
  server: McpServer,
  observability:
    McpObservabilityStore,
  audit?: AuditStore,
): void {
  server.registerResource(
    "Junius Observability Panel",
    PANEL_RESOURCE_URI,
    {
      description:
        "Junius tool activity and audit logs for the current ChatGPT conversation.",
      mimeType:
        MCP_APP_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri:
            PANEL_RESOURCE_URI,
          mimeType:
            MCP_APP_MIME_TYPE,
          text:
            await panelHtml(),
          _meta: {
            ui: {
              prefersBorder:
                false,
            },
            "openai/widgetDescription":
              "Junius 工具调用与日志监控面板。",
          },
        },
      ],
    }),
  );

  server.registerTool(
    JUNIUS_PANEL_TOOL,
    {
      title:
        "Junius 监控",
      description:
        "Open the Junius test window in the current ChatGPT conversation. Users may also open this thread panel manually from the ChatGPT UI.",
      inputSchema:
        z.object({}),
      _meta:
        panelToolMeta(),
      annotations: {
        readOnlyHint: true,
        destructiveHint:
          false,
        idempotentHint:
          true,
        openWorldHint:
          false,
      },
    },
    async (_args, context) => ({
      content: [],
      structuredContent:
        panelSnapshot(
          observability,
          audit,
          context,
        ),
    }),
  );

  server.registerTool(
    JUNIUS_TEST_WINDOW_CLOSE_TOOL,
    {
      title:
        "关闭 Junius 测试窗口",
      description:
        "Close the currently mounted Junius test window for this ChatGPT conversation.",
      inputSchema:
        z.object({}),
      _meta:
        modelOnlyToolMeta(),
      annotations: {
        readOnlyHint: true,
        destructiveHint:
          false,
        idempotentHint:
          true,
        openWorldHint:
          false,
      },
    },
    async (_args, context) => {
      const identity =
        extractOpenAiRequestIdentity(
          context.mcpReq._meta,
        );
      if (identity.sessionId === undefined) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                "Cannot close the Junius test window because ChatGPT did not provide a conversation session id.",
            },
          ],
        };
      }

      const closeRevision =
        observability.requestTestWindowClose(
          identity.sessionId,
        );

      return {
        content: [
          {
            type: "text" as const,
            text:
              "Junius test window close requested for this conversation.",
          },
        ],
        structuredContent: {
          testWindowCloseRevision:
            closeRevision,
        },
      };
    },
  );

  server.registerTool(
    JUNIUS_PANEL_SNAPSHOT_TOOL,
    {
      title:
        "Read Junius observability snapshot",
      description:
        "Return the current Junius tool-call snapshot and recent audit events for the mounted Junius panel.",
      inputSchema:
        z.object({}),
      _meta:
        appOnlyToolMeta(),
      annotations: {
        readOnlyHint: true,
        destructiveHint:
          false,
        idempotentHint:
          true,
        openWorldHint:
          false,
      },
    },
    async (_args, context) => ({
      content: [],
      structuredContent:
        panelSnapshot(
          observability,
          audit,
          context,
        ),
    }),
  );
}
