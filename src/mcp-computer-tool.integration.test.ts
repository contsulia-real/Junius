import assert from "node:assert/strict";
import test from "node:test";
import { McpServer, type RegisteredTool, type ServerContext } from "@modelcontextprotocol/server";
import { ComputerSessionManager } from "./mcp-computer-sessions.js";
import { McpObservabilityStore } from "./mcp-observability.js";
import { attachMcpObservability } from "./mcp-observability-server.js";
import { registerMcpTurnTools } from "./mcp-turn-tools.js";
import { registerBrowserTool } from "./mcp-browser-tool.js";
import { registerDesktopTool } from "./mcp-desktop-tool.js";
import { withMcpSessionContext } from "./mcp-session-context.js";
import type { PlaywrightCliService } from "./playwright-cli.js";
import { DesktopComputerUseError, type DesktopComputerUseService } from "./desktop-computer-use.js";

type Result = { structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[]; isError?: boolean };
function context(): ServerContext {
  return { mcpReq: { _meta: {} } } as unknown as ServerContext;
}

function fixture() {
  const browserCalls: { session: string; command: string }[] = [];
  const desktopCalls: { session: string; command: string }[] = [];
  let interruptDesktop = false;
  const browser = {
    async run(session: string, command: string) {
      browserCalls.push({ session, command });
      return { session, command, exitCode: 0, stdout: "SYNTHETIC", stderr: "", durationMs: 0, transport: "spawn" as const };
    },
  } as unknown as PlaywrightCliService;
  const desktop = {
    async run(req: { session: string; command: string }) {
      desktopCalls.push({ session: req.session, command: req.command });
      if (interruptDesktop && req.command !== "control_end") {
        throw new DesktopComputerUseError("user_interrupted", "synthetic Exit button");
      }
      return { session: req.session, command: req.command, result: {}, durationMs: 0 };
    },
    state() { return { helperRunning: true }; },
  } as DesktopComputerUseService;
  const server = new McpServer({ name: "Synthetic Junius", version: "0" });
  const obs = new McpObservabilityStore();
  const sessions = new ComputerSessionManager();
  registerBrowserTool(server, browser, sessions, obs);
  registerDesktopTool(server, desktop, sessions, obs);
  registerMcpTurnTools(server, obs, sessions, browser, desktop);
  attachMcpObservability(server, obs);
  const internal = server as unknown as {
    _registeredTools: Record<string, RegisteredTool>;
    executeToolHandler(tool: RegisteredTool, args: unknown, context: ServerContext): Promise<Result>;
  };
  function call(chat: string, name: string, args: unknown = {}): Promise<Result> {
    return withMcpSessionContext(chat, () =>
      internal.executeToolHandler(internal._registeredTools[name]!, args, context()));
  }
  async function begin(chat: string) {
    await call(chat, "junius_turn_begin", { parts: [{ type: "text", text: "synthetic user intent" }] });
    await call(chat, "junius_task_review", {
      objective: "Check direct Browser and Desktop execution without a Junius consent widget",
      scope: "Only synthetic in-memory fake device helpers with per-Chat session isolation",
      risks: "Retain lifecycle cleanup and Desktop Exit button interrupts",
      verification: "No permission tool registered and device calls run directly",
    });
  }
  return { browserCalls, desktopCalls, call, begin, internal,
    interruptDesktop: () => { interruptDesktop = true; },
  };
}

test("Browser operates directly with Chat-isolated named sessions, without a consent widget", async () => {
  const f = fixture();
  assert.equal(f.internal._registeredTools.junius_computer_permission_request, undefined);
  assert.equal(f.internal._registeredTools.junius_computer_permission_state, undefined);
  assert.equal(f.internal._registeredTools.junius_computer_permission_decide, undefined);
  await f.begin("A");
  const args = { session: "browser", command: "snapshot", args: [] };
  assert.notEqual((await f.call("A", "playwright_cli", args)).isError, true);
  assert.equal(f.browserCalls.length, 1);
  await f.begin("B");
  assert.notEqual((await f.call("B", "playwright_cli", args)).isError, true);
  assert.notEqual(f.browserCalls[0]!.session, f.browserCalls[1]!.session);
  assert.equal((await f.call("A", "playwright_cli", { ...args, command: "close" })).isError, undefined);
  assert.equal(f.browserCalls.at(-1)?.command, "close");
});

test("Desktop starts control automatically and closes at turn end, without a consent widget", async () => {
  const f = fixture();
  await f.begin("A");
  assert.notEqual((await f.call("A", "desktop", { session: "pc", command: "windows" })).isError, true);
  assert.deepEqual(f.desktopCalls.map(x => x.command), ["control_begin", "windows"]);
  assert.equal((await f.call("A", "junius_turn_end")).structuredContent?.ended, true);
  assert.equal(f.desktopCalls.at(-1)?.command, "control_end");
  await f.begin("B");
  assert.notEqual((await f.call("B", "desktop", { session: "pc", command: "screenshot" })).isError, true);
  assert.notEqual(f.desktopCalls[0]!.session, f.desktopCalls.at(-1)!.session);
});

test("Desktop Exit button stops Desktop for the rest of the turn", async () => {
  const f = fixture();
  await f.begin("A");
  f.interruptDesktop();
  const args = { session: "pc", command: "windows" };
  assert.equal((await f.call("A", "desktop", args)).isError, true);
  const count = f.desktopCalls.length;
  assert.equal((await f.call("A", "desktop", args)).isError, true);
  assert.equal(f.desktopCalls.length, count);
});
