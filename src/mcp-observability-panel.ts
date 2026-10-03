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
  JUNIUS_TEST_WINDOW_OPEN_TOOL,
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
    JUNIUS_TEST_WINDOW_OPEN_TOOL,
    {
      title:
        "打开 Junius 测试窗口",
      description:
        "Only call this tool when the current user explicitly asks in ChatGPT chat to open or show the Junius test window. Never call it proactively, infer permission from debugging work, or use it because another Junius tool ran. After it succeeds, call junius_observability_panel once in the same user request to mount the authorized conversation-side panel.",
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
                "Cannot open the Junius test window because ChatGPT did not provide a conversation session id.",
            },
          ],
        };
      }

      observability.setTestWindowOpen(
        identity.sessionId,
        true,
      );

      return {
        content: [
          {
            type: "text" as const,
            text:
              "Junius test window is authorized to open for this conversation.",
          },
        ],
        structuredContent: {
          testWindowOpen: true,
        },
      };
    },
  );

  server.registerTool(
    JUNIUS_PANEL_TOOL,
    {
      title:
        "Junius 监控",
      description:
        "Mount the Junius test window in the current ChatGPT conversation. Call this only immediately after open_junius_test_window succeeded for the user's current explicit request. This tool does not authorize opening by itself; unauthorized mounts close themselves.",
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
        "Only call this tool when the current user explicitly asks in ChatGPT chat to close, hide, or dismiss the Junius test window. Never close it proactively or because the conversation became idle.",
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

      observability.setTestWindowOpen(
        identity.sessionId,
        false,
      );

      return {
        content: [
          {
            type: "text" as const,
            text:
              "Junius test window is authorized to close for this conversation.",
          },
        ],
        structuredContent: {
          testWindowOpen: false,
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
