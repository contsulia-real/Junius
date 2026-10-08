import type { McpServer } from "@modelcontextprotocol/server";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ComputerPermissionManager, COMPUTER_DECISIONS, type ComputerTool } from "./mcp-computer-permission.js";
import { observabilitySessionId } from "./mcp-session-context.js";

export const COMPUTER_PERMISSION_URI = "ui://junius/computer-permission-v2.html";
const PANEL_PATH = fileURLToPath(new URL("../ui/computer-permission.html", import.meta.url));
const widgetMeta = {
  ui: { resourceUri: COMPUTER_PERMISSION_URI, visibility: ["model", "app"] },
  "ui/resourceUri": COMPUTER_PERMISSION_URI,
  "openai/outputTemplate": COMPUTER_PERMISSION_URI,
  securitySchemes: [{ type: "noauth" }],
};
export function computerPermissionToolMeta(): Record<string, unknown> {
  // Browser/Desktop calls should never automatically mount permission widgets.
  return { ui: { visibility: ["model"] }, securitySchemes: [{ type: "noauth" }] };
}
export function computerPermissionPrompt(tool: ComputerTool, purpose: string) {
  const label = tool === "browser" ? "Playwright 浏览器" : "Computer Use 桌面";
  const risk = tool === "browser"
    ? "可能访问已登录网页及浏览器状态。"
    : "可能查看屏幕、窗口和剪贴板，并控制键盘鼠标。";
  return {
    content: [{ type: "text" as const, text: `需要用户在 Junius 授权面板中确认是否使用${label}。用途：${purpose}。${risk}。当前未获授权，设备操作已阻止。请调用 junius_computer_permission_request 打开一次授权面板，等待用户点击；只有取得真实授权后才能重试设备工具。` }],
    structuredContent: { permissionRequired: true, tool, purpose, risk },
  };
}
export function registerComputerPermissionPanel(server: McpServer, permissions: ComputerPermissionManager): void {
  server.registerResource("Junius Computer Permission", COMPUTER_PERMISSION_URI,
    { mimeType: "text/html;profile=mcp-app", description: "Four-way Browser/Desktop consent panel" },
    async () => ({
      contents: [{
        uri: COMPUTER_PERMISSION_URI,
        mimeType: "text/html;profile=mcp-app",
        text: await readFile(PANEL_PATH, "utf8"),
        _meta: { ui: { prefersBorder: true }, "openai/widgetDescription": "Junius 设备操作授权" },
      }],
    }),
  );
  server.registerTool("junius_computer_permission_request", {
    title: "Request Browser/Desktop permission",
    description: "Only call when playwright_cli or desktop has returned permissionRequired. Opens the user's four-choice Junius permission widget for the currently pending request. Never call when already authorized or for ordinary device operations.",
    inputSchema: z.object({}),
    _meta: widgetMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (_args, context) => {
    const chat = observabilitySessionId(context.mcpReq._meta);
    const pending = chat ? permissions.pending(chat) : undefined;
    if (!pending) {
      return { isError: true, content: [{ type: "text" as const, text: "No pending Browser/Desktop permission request." }],
        structuredContent: { status: "unavailable" } };
    }
    return { content: [{ type: "text" as const, text: "Waiting for the user's four-way consent decision in the Junius permission widget. Do not retry device access before an explicit allow choice." }],
      structuredContent: { status: "pending", tool: pending.tool, purpose: pending.purpose, nonce: pending.nonce } };
  });
  const appOnly = { ui: { visibility: ["app"] }, securitySchemes: [{ type: "noauth" }] };
  server.registerTool("junius_computer_permission_state", {
    title: "Read computer permission request",
    description: "Read the pending request from the Junius permission panel.",
    inputSchema: z.object({ nonce: z.string().uuid().optional() }),
    _meta: appOnly,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ nonce }, context) => {
    const chat = observabilitySessionId(context.mcpReq._meta);
    const pending = nonce
      ? permissions.pendingByNonce(nonce)
      : chat ? permissions.pending(chat) : undefined;
    const matching = pending && (!nonce || chat === undefined || chat === ("chat" in pending ? pending.chat : chat));
    return { content: [], structuredContent: matching
      ? { status: "pending", tool: pending.tool, purpose: pending.purpose, nonce: pending.nonce }
      : { status: "unavailable" } };
  });
  server.registerTool("junius_computer_permission_decide", {
    title: "Record computer permission choice",
    description: "Record the explicit user's button selection in the Junius permission panel.",
    inputSchema: z.object({
      nonce: z.string().uuid(),
      decision: z.enum(COMPUTER_DECISIONS),
    }),
    _meta: appOnly,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ nonce, decision }, context) => {
    const chat = observabilitySessionId(context.mcpReq._meta);
    const pending = permissions.pendingByNonce(nonce);
    const ok = permissions.decideByNonce(nonce, decision, chat);
    return {
      content: [],
      structuredContent: {
        ok,
        ...(ok && pending ? { tool: pending.tool, decision, purpose: pending.purpose } : {}),
      },
    };
  });
}
