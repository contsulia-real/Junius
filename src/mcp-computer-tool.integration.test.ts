import assert from "node:assert/strict";
import test from "node:test";
import { McpServer, type RegisteredTool, type ServerContext } from "@modelcontextprotocol/server";
import { ComputerPermissionManager } from "./mcp-computer-permission.js";
import { McpObservabilityStore } from "./mcp-observability.js";
import { attachMcpObservability } from "./mcp-observability-server.js";
import { registerMcpTurnTools } from "./mcp-turn-tools.js";
import { registerBrowserTool } from "./mcp-browser-tool.js";
import { registerDesktopTool } from "./mcp-desktop-tool.js";
import { withMcpSessionContext } from "./mcp-session-context.js";
import { PlaywrightCliError, type PlaywrightCliService } from "./playwright-cli.js";
import { DesktopComputerUseError, type DesktopComputerUseService } from "./desktop-computer-use.js";

type Result = { resultType?: string; requestState?: string; inputRequests?: unknown; isError?: boolean };
type BrowserCall = { session: string; command: string; authorized?: true };
type DesktopCall = { session: string; command: string; authorized?: true };
function context(token?: string, decision?: string): ServerContext {
  return {
    mcpReq: {
      _meta: {},
      requestState: () => token,
      inputResponses: decision ? {
        permission: { action: "accept", content: { decision } },
      } : undefined,
    },
  } as unknown as ServerContext;
}
function fixture() {
  const browserCalls: BrowserCall[] = [], desktopCalls: DesktopCall[] = [];
  let interruptBrowser = false, interruptDesktop = false;
  const browser = {
    async run(session: string, command: string, _args: readonly string[], authorized?: true) {
      browserCalls.push({ session, command, authorized });
      if (interruptBrowser && command !== "close") {
        throw new PlaywrightCliError("user_interrupted", "synthetic interruption");
      }
      return { session, command, exitCode: 0, stdout: "SYNTHETIC", stderr: "", durationMs: 0, transport: "spawn" as const };
    },
  } as PlaywrightCliService;
  const desktop = {
    async run(req: { session: string; command: string; explicitUserAuthorization?: true }) {
      desktopCalls.push({ session: req.session, command: req.command, authorized: req.explicitUserAuthorization });
      if (interruptDesktop && req.command !== "control_end") {
        throw new DesktopComputerUseError("user_interrupted", "synthetic interruption");
      }
      return { session: req.session, command: req.command, result: {}, durationMs: 0 };
    },
  } as DesktopComputerUseService;
  const server = new McpServer({ name: "Synthetic Junius", version: "0" });
  const obs = new McpObservabilityStore();
  const permissions = new ComputerPermissionManager();
  registerBrowserTool(server, browser, permissions, obs);
  registerDesktopTool(server, desktop, permissions, obs);
  registerMcpTurnTools(server, obs, permissions, browser, desktop);
  attachMcpObservability(server, obs);
  const internal = server as unknown as {
    _registeredTools: Record<string, RegisteredTool>;
    executeToolHandler(tool: RegisteredTool, args: unknown, context: ServerContext): Promise<Result>;
  };
  function call(chat: string, name: string, args: unknown, ctx = context()): Promise<Result> {
    return withMcpSessionContext(chat, () =>
      internal.executeToolHandler(internal._registeredTools[name]!, args, ctx));
  }
  async function begin(chat: string) {
    await call(chat, "junius_turn_begin", { parts: [{ type: "text", text: "synthetic user intent" }] });
  }
  async function end(chat: string) {
    await call(chat, "junius_turn_end", {});
  }
  return {
    browserCalls, desktopCalls, call, begin, end,
    interruptBrowser: () => { interruptBrowser = true; },
    interruptDesktop: () => { interruptDesktop = true; },
  };
}

test("real MCP tool path asks for consent and never executes before acceptance", async () => {
  const f = fixture();
  await f.begin("Chat-A");
  const arg = { session: "junius", command: "snapshot", args: [], purpose: "核查合成网页内容" };
  const first = await f.call("Chat-A", "playwright_cli", arg);
  assert.equal(first.resultType, "input_required");
  assert.equal(f.browserCalls.length, 0);
  const accepted = await f.call("Chat-A", "playwright_cli", arg, context(first.requestState, "允许本轮"));
  assert.notEqual(accepted.isError, true);
  assert.equal(f.browserCalls.length, 1);
  assert.equal(f.browserCalls[0]!.authorized, true);
  await f.call("Chat-A", "playwright_cli", arg);
  assert.equal(f.browserCalls[1]!.authorized, undefined);
  await f.end("Chat-A");
  assert.equal(f.browserCalls.at(-1)?.command, "close");
  await f.begin("Chat-A");
  const again = await f.call("Chat-A", "playwright_cli", arg);
  assert.equal(again.resultType, "input_required");
  assert.equal(f.browserCalls.length, 3);
});

test("Chat-scoped permission never crosses Chat and Escape blocks the remainder of the turn", async () => {
  const f = fixture();
  await f.begin("Chat-A");
  const arg = { command: "windows", purpose: "查看合成桌面窗口" };
  const first = await f.call("Chat-A", "desktop", arg);
  assert.equal(first.resultType, "input_required");
  assert.equal(f.desktopCalls.length, 0);
  const accepted = await f.call("Chat-A", "desktop", arg, context(first.requestState, "允许本会话"));
  assert.notEqual(accepted.isError, true);
  assert.deepEqual(f.desktopCalls.map(x => x.command), ["control_begin", "windows"]);
  await f.end("Chat-A");
  assert.equal(f.desktopCalls.at(-1)?.command, "control_end");
  await f.begin("Chat-A");
  const continued = await f.call("Chat-A", "desktop", arg);
  assert.notEqual(continued.resultType, "input_required");
  assert.deepEqual(f.desktopCalls.slice(-2).map(x => x.command), ["control_begin", "windows"]);
  await f.begin("Chat-B");
  const other = await f.call("Chat-B", "desktop", arg);
  assert.equal(other.resultType, "input_required");
  const otherAccepted = await f.call("Chat-B", "desktop", arg, context(other.requestState, "允许本轮"));
  assert.notEqual(otherAccepted.isError, true);
  assert.notEqual(f.desktopCalls[0]?.session, f.desktopCalls.at(-1)?.session);
  f.interruptDesktop();
  const interrupted = await f.call("Chat-A", "desktop", arg);
  assert.equal(interrupted.isError, true);
  const count = f.desktopCalls.length;
  const stopped = await f.call("Chat-A", "desktop", arg);
  assert.equal(stopped.isError, true);
  assert.equal(f.desktopCalls.length, count);
  await f.end("Chat-A");
  await f.end("Chat-B");
});
