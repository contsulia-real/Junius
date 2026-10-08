import assert from "node:assert/strict";
import test from "node:test";
import { parseToolCall, routeKeyForTool } from "./reverse-proxy-routing.js";

test("browser and desktop routing keys are isolated by the transport or Chat session", () => {
  const browser = { name: "playwright_cli", arguments: { session: "junius" } };
  const desktop = { name: "desktop", arguments: { session: "junius" } };
  assert.notEqual(routeKeyForTool(browser, "Chat-A"), routeKeyForTool(browser, "Chat-B"));
  assert.notEqual(routeKeyForTool(desktop, "Chat-A"), routeKeyForTool(desktop, "Chat-B"));
  assert.notEqual(routeKeyForTool(browser, "Chat-A"), routeKeyForTool(desktop, "Chat-A"));
  const body = (chat: string) => Buffer.from(JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { ...browser, _meta: { "openai/session": chat } },
  }));
  const a = parseToolCall(body("Chat-A"));
  const b = parseToolCall(body("Chat-B"));
  assert.equal(a?.chatId, "openai:Chat-A");
  assert.notEqual(routeKeyForTool(a, a?.chatId), routeKeyForTool(b, b?.chatId));
});
