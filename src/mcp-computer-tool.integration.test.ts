import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { McpServer, type RegisteredTool, type ServerContext } from "@modelcontextprotocol/server";
import { ComputerPermissionManager } from "./mcp-computer-permission.js";
import { registerComputerPermissionPanel, COMPUTER_PERMISSION_URI } from "./mcp-computer-permission-panel.js";
import { McpObservabilityStore } from "./mcp-observability.js";
import { attachMcpObservability } from "./mcp-observability-server.js";
import { registerMcpTurnTools } from "./mcp-turn-tools.js";
import { registerBrowserTool } from "./mcp-browser-tool.js";
import { registerDesktopTool } from "./mcp-desktop-tool.js";
import { withMcpSessionContext } from "./mcp-session-context.js";
import { PlaywrightCliError, type PlaywrightCliService } from "./playwright-cli.js";
import { DesktopComputerUseError, type DesktopComputerUseService } from "./desktop-computer-use.js";

type Result = { structuredContent?: Record<string, unknown>; content?: unknown[]; isError?: boolean };
type BrowserCall = { session: string; command: string; authorized?: true };
type DesktopCall = { session: string; command: string; authorized?: true };
function context(): ServerContext {
  return { mcpReq: { _meta: {} } } as unknown as ServerContext;
}
function fixture() {
  const browserCalls: BrowserCall[] = [], desktopCalls: DesktopCall[] = [];
  let interruptDesktop = false;
  const browser = {
    async run(session: string, command: string, _args: readonly string[], authorized?: true) {
      browserCalls.push({ session, command, authorized });
      return { session, command, exitCode: 0, stdout: "SYNTHETIC", stderr: "", durationMs: 0, transport: "spawn" as const };
    },
  } as PlaywrightCliService;
  const desktop = {
    async run(req: { session: string; command: string; explicitUserAuthorization?: true }) {
      desktopCalls.push({ session: req.session, command: req.command, authorized: req.explicitUserAuthorization });
      if (interruptDesktop && req.command !== "control_end") {
        throw new DesktopComputerUseError("user_interrupted", "synthetic");
      }
      return { session: req.session, command: req.command, result: {}, durationMs: 0 };
    },
  } as DesktopComputerUseService;
  const server = new McpServer({ name: "Synthetic Junius", version: "0" });
  const obs = new McpObservabilityStore();
  const permissions = new ComputerPermissionManager();
  registerBrowserTool(server, browser, permissions, obs);
  registerDesktopTool(server, desktop, permissions, obs);
  registerComputerPermissionPanel(server, permissions);
  registerMcpTurnTools(server, obs, permissions, browser, desktop);
  attachMcpObservability(server, obs);
  const internal = server as unknown as {
    _registeredTools: Record<string, RegisteredTool>;
    executeToolHandler(tool: RegisteredTool, args: unknown, context: ServerContext): Promise<Result>;
  };
  function call(chat: string | undefined, name: string, args: unknown): Promise<Result> {
    return withMcpSessionContext(chat, () =>
      internal.executeToolHandler(internal._registeredTools[name]!, args, context()));
  }
  async function begin(chat: string) {
    await call(chat, "junius_turn_begin", { parts: [{ type: "text", text: "synthetic user intent" }] });
    await call(chat, "junius_task_review", { objective: "Exercise synthetic Browser/Desktop permissions", scope: "Only in-memory fake tools and one Chat turn", risks: "Permission scopes and user clicks must never be fabricated", verification: "Assert zero real access before approval and correct behavior afterward" });
  }
  async function end(chat: string) { await call(chat, "junius_turn_end", {}); }
  async function decision(chat: string, value: string) {
    const status = await call(chat, "junius_computer_permission_state", {});
    const nonce = status.structuredContent?.nonce;
    assert.equal(typeof nonce, "string");
    return call(chat, "junius_computer_permission_decide", { nonce, decision: value });
  }
  return { browserCalls, desktopCalls, call, begin, end, decision,
    interruptDesktop: () => { interruptDesktop = true; }, internal };
}

test("MCP UI consent works without client elicitation and never runs before clicking", async () => {
  const f = fixture();
  await f.begin("Chat-A");
  const arg = { session: "junius", command: "snapshot", args: [], purpose: "核查合成网页内容" };
  const result = await f.call("Chat-A", "playwright_cli", arg);
  assert.equal(result.structuredContent?.permissionRequired, true);
  assert.equal(f.browserCalls.length, 0);
  const meta = f.internal._registeredTools.playwright_cli!._meta as { ui?: { resourceUri?: string } };
  assert.equal(meta?.ui?.resourceUri, undefined, "normal browser tool must not mount consent UI");
  const consent = await f.call("Chat-A", "junius_computer_permission_request", {});
  assert.equal(consent.structuredContent?.status, "pending");
  assert.equal(typeof consent.structuredContent?.nonce, "string");
  const requestMeta = f.internal._registeredTools.junius_computer_permission_request!._meta as { ui?: { resourceUri?: string } };
  assert.equal(requestMeta?.ui?.resourceUri, COMPUTER_PERMISSION_URI);
  const denied = await f.call("Chat-B", "junius_computer_permission_state", {});
  assert.equal(denied.structuredContent?.status, "unavailable");
  // A widget choice is received after the prior model turn ends.
  await f.end("Chat-A");
  assert.equal((await f.decision("Chat-A", "允许本轮")).structuredContent?.ok, true);
  await f.begin("Chat-A");
  const accepted = await f.call("Chat-A", "playwright_cli", arg);
  assert.notEqual(accepted.isError, true);
  assert.equal(f.browserCalls.length, 1);
  assert.equal(f.browserCalls[0]!.authorized, true);
  await f.end("Chat-A");
  assert.equal(f.browserCalls.at(-1)?.command, "close");
  await f.begin("Chat-A");
  const again = await f.call("Chat-A", "playwright_cli", arg);
  assert.equal(again.structuredContent?.permissionRequired, true);
});

test("widget can read and decide only its own pending nonce when app session metadata is absent", async () => {
  const f = fixture();
  await f.begin("Chat-A");
  const input = { session: "junius", command: "snapshot", args: [], purpose: "核查已授权网页状态" };
  assert.equal((await f.call("Chat-A", "playwright_cli", input)).structuredContent?.permissionRequired, true);
  const widget = await f.call("Chat-A", "junius_computer_permission_request", {});
  const nonce = widget.structuredContent?.nonce;
  assert.equal(typeof nonce, "string");
  assert.equal((await f.call(undefined, "junius_computer_permission_state", { nonce })).structuredContent?.status, "pending");
  assert.equal((await f.call(undefined, "junius_computer_permission_state", { nonce: "00000000-0000-4000-8000-000000000000" })).structuredContent?.status, "unavailable");
  await f.end("Chat-A");
  assert.equal((await f.call(undefined, "junius_computer_permission_decide", { nonce, decision: "允许本会话" })).structuredContent?.ok, true);
  assert.equal((await f.call(undefined, "junius_computer_permission_decide", { nonce, decision: "允许本会话" })).structuredContent?.ok, false);
  await f.begin("Chat-A");
  assert.notEqual((await f.call("Chat-A", "playwright_cli", input)).structuredContent?.permissionRequired, true);
  assert.equal(f.browserCalls.length, 1);
  const needless = await f.call("Chat-A", "junius_computer_permission_request", {});
  assert.equal(needless.isError, true, "no more permission UI once Chat consent is granted");
});


test("actual MCP App script enables a pending request and records a clicked choice", async () => {
  const f = fixture();
  await f.begin("Chat-A");
  const input = { session: "junius", command: "snapshot", args: [], purpose: "检查页面设备授权" };
  await f.call("Chat-A", "playwright_cli", input);
  const consent = await f.call("Chat-A", "junius_computer_permission_request", {});
  assert.equal(f.browserCalls.length, 0);

  const html = readFileSync(new URL("../ui/computer-permission.html", import.meta.url), "utf8");
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  const elements = new Map(["status", "tool", "purpose", "risk"].map(id => [id, { textContent: "" }]));
  const choices = ["允许本轮", "允许本会话", "拒绝本轮", "拒绝本会话"];
  const buttons = choices.map(choice => ({
    disabled: true,
    dataset: { choice },
    click: async () => {},
    addEventListener(_name: string, handler: () => Promise<void>) { this.click = handler; },
  }));
  type Message = { source: unknown; data: Record<string, unknown> };
  const listeners: Array<(event: Message) => void> = [];
  const followUps: string[] = [];
  const parent = {
    postMessage(message: { jsonrpc: string; id?: number; method?: string; params?: { name: string; arguments: unknown } }) {
      if (message.id === undefined) return;
      const response = message.method === "tools/call"
        ? f.call(undefined, message.params!.name, message.params!.arguments)
        : Promise.resolve({ structuredContent: {} });
      void response.then(result => {
        for (const listener of listeners) listener({
          source: parent,
          data: { jsonrpc: "2.0", id: message.id, result },
        });
      });
    },
  };
  const window = {
    parent,
    addEventListener(_name: string, listener: (event: Message) => void) { listeners.push(listener); },
    openai: {
      toolOutput: null,
      async sendFollowUpMessage({ prompt }: { prompt: string }) { followUps.push(prompt); },
    },
  };
  const document = {
    getElementById(id: string) { return elements.get(id); },
    querySelectorAll() { return buttons; },
  };
  runInNewContext(script, { window, document });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(buttons[1]!.disabled, true, "without request data the widget must not grant access");

  for (const listener of listeners) listener({
    source: parent,
    data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: consent.structuredContent } },
  });
  assert.equal(buttons[1]!.disabled, false);
  assert.match(elements.get("purpose")!.textContent, /检查页面设备授权/u);
  await buttons[1]!.click();
  assert.equal(buttons[1]!.disabled, true);
  assert.match(elements.get("status")!.textContent, /已记录：允许本会话/u);
  assert.equal(followUps.length, 1);
  assert.equal(f.browserCalls.length, 0);

  await f.end("Chat-A");
  await f.begin("Chat-A");
  assert.notEqual((await f.call("Chat-A", "playwright_cli", input)).structuredContent?.permissionRequired, true);
  assert.equal(f.browserCalls.length, 1);
});

test("chat consent and Escape are isolated, including app-only request results", async () => {
  const f = fixture();
  await f.begin("A");
  const arg = { command: "windows", purpose: "查看合成桌面窗口" };
  const first = await f.call("A", "desktop", arg);
  assert.equal(first.structuredContent?.permissionRequired, true);
  assert.equal(f.desktopCalls.length, 0);
  const desktopMeta = f.internal._registeredTools.desktop!._meta as { ui?: { resourceUri?: string } };
  assert.equal(desktopMeta?.ui?.resourceUri, undefined, "ordinary Desktop must not mount a consent panel");
  const desktopConsent = await f.call("A", "junius_computer_permission_request", {});
  assert.equal(desktopConsent.structuredContent?.status, "pending");
  assert.equal(desktopConsent.structuredContent?.tool, "desktop");
  const status = await f.call("A", "junius_computer_permission_state", {});
  const nonce = status.structuredContent!.nonce;
  assert.equal((await f.call("B", "junius_computer_permission_decide", { nonce, decision: "允许本会话" })).structuredContent?.ok, false);
  await f.end("A");
  assert.equal((await f.decision("A", "允许本会话")).structuredContent?.ok, true);
  await f.begin("A");
  await f.call("A", "desktop", arg);
  assert.deepEqual(f.desktopCalls.map(x => x.command), ["control_begin", "windows"]);
  await f.end("A");
  assert.equal(f.desktopCalls.at(-1)?.command, "control_end");
  await f.begin("A");
  const continued = await f.call("A", "desktop", arg);
  assert.notEqual(continued.structuredContent?.permissionRequired, true);
  assert.equal((await f.call("A", "junius_computer_permission_request", {})).isError, true);
  await f.begin("B");
  assert.equal((await f.call("B", "desktop", arg)).structuredContent?.permissionRequired, true);
  f.interruptDesktop();
  const interrupted = await f.call("A", "desktop", arg);
  assert.equal(interrupted.isError, true);
  const count = f.desktopCalls.length;
  assert.equal((await f.call("A", "desktop", arg)).isError, true);
  assert.equal(f.desktopCalls.length, count);
});
