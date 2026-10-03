import type {
  McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  readFile,
} from "node:fs/promises";
import {
  fileURLToPath,
} from "node:url";
import type {
  McpObservabilityStore,
} from "./mcp-observability.js";
import {
  observabilitySessionId,
} from "./mcp-session-context.js";
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
  metadata?: unknown,
): Record<string, unknown> {
  return {
    ...observability.snapshot(
      observabilitySessionId(
        metadata,
      ),
    ),
  };
}

export function registerMcpObservabilityPanel(
  server: McpServer,
  observability:
    McpObservabilityStore,
): void {
  server.registerResource(
    "Junius Observability Panel",
    PANEL_RESOURCE_URI,
    {
      description:
        "Persistent Junius turn, Skill, and tool activity for the current MCP session.",
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
              "Junius MCP session、turn、Skill、工具调用与事件日志面板。",
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
        "Open the Junius observability panel for the current MCP session. Users may also open this thread panel manually from the ChatGPT UI.",
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
          context.mcpReq._meta,
        ),
    }),
  );

  server.registerTool(
    JUNIUS_TEST_WINDOW_CLOSE_TOOL,
    {
      title:
        "关闭 Junius 测试窗口",
      description:
        "Close the currently mounted Junius observability panel for this MCP session.",
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
      const sessionId =
        observabilitySessionId(
          context.mcpReq._meta,
        );
      if (sessionId === undefined) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                "Cannot close the Junius test window because no MCP transport session or ChatGPT conversation session is available.",
            },
          ],
        };
      }

      const closeRevision =
        observability.requestTestWindowClose(
          sessionId,
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
        "Return the current Junius turn snapshot for the mounted Junius panel.",
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
          context.mcpReq._meta,
        ),
    }),
  );
}
