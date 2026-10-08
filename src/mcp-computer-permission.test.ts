import assert from "node:assert/strict";
import test from "node:test";
import type { ServerContext } from "@modelcontextprotocol/server";
import { ComputerPermissionManager } from "./mcp-computer-permission.js";

type Choice = "允许本轮" | "允许本会话" | "拒绝本轮" | "拒绝本会话";

function context(state?: string, choice?: Choice | "cancelled"): ServerContext {
  return {
    mcpReq: {
      requestState: () => state,
      inputResponses: choice === undefined ? undefined : {
        permission: choice === "cancelled"
          ? { action: "cancel" }
          : { action: "accept", content: { decision: choice } },
      },
    },
  } as unknown as ServerContext;
}

function request(permissions: ComputerPermissionManager, chat: string, turn: string, tool: "browser" | "desktop") {
  const response = permissions.authorize(chat, turn, tool, "检查合成页面", context());
  assert.equal(typeof response, "object");
  if (typeof response !== "object") throw new Error("expected a real user choice");
  assert.equal(response.resultType, "input_required");
  assert.equal(response.inputRequests?.permission.method, "elicitation/create");
  return response.requestState!;
}

test("computer permission requires an actual four-way client response and scopes it to turn or Chat", () => {
  const p = new ComputerPermissionManager();
  p.beginTurn("A");
  const token = request(p, "A", "turn-1", "browser");
  assert.equal(p.authorize("A", "turn-1", "browser", "x", context(token, "允许本轮")), true);
  assert.equal(p.authorize("A", "turn-1", "browser", "x", context()), true);
  assert.notEqual(p.authorize("B", "turn-1", "browser", "x", context()), true);
  assert.notEqual(p.authorize("A", "turn-1", "desktop", "x", context()), true);
  p.endTurn("A");
  p.beginTurn("A");
  assert.notEqual(p.authorize("A", "turn-2", "browser", "x", context()), true);
  const second = request(p, "A", "turn-2", "desktop");
  assert.equal(p.authorize("A", "turn-2", "desktop", "x", context(second, "允许本会话")), true);
  p.endTurn("A");
  p.beginTurn("A");
  assert.equal(p.authorize("A", "turn-3", "desktop", "x", context()), true);
  p.endChat("A");
  p.beginTurn("A");
  assert.notEqual(p.authorize("A", "turn-4", "desktop", "x", context()), true);
});

test("decline, cancellation and forged responses fail closed at the right scope", () => {
  const p = new ComputerPermissionManager();
  p.beginTurn("A");
  const first = request(p, "A", "1", "desktop");
  assert.equal(p.authorize("A", "1", "desktop", "x", context(first, "cancelled")), false);
  assert.equal(p.authorize("A", "1", "desktop", "x", context()), false);
  p.endTurn("A");
  p.beginTurn("A");
  const second = request(p, "A", "2", "desktop");
  assert.equal(p.authorize("A", "2", "desktop", "x", context(second, "拒绝本会话")), false);
  p.endTurn("A");
  p.beginTurn("A");
  assert.equal(p.authorize("A", "3", "desktop", "x", context()), false);
  const legit = request(p, "A", "3", "browser");
  const forged = p.authorize("A", "3", "browser", "x", context("not-a-server-nonce", "允许本会话"));
  assert.notEqual(forged, true);
  assert.notEqual(p.authorize("A", "3", "browser", "x", context(legit, "允许本会话")), true);
});

test("Escape and session names cannot carry permission across Chat sessions", () => {
  const p = new ComputerPermissionManager();
  p.beginTurn("A");
  const token = request(p, "A", "1", "browser");
  assert.equal(p.authorize("A", "1", "browser", "x", context(token, "允许本会话")), true);
  const nameA = p.session("A", "junius");
  const nameB = p.session("B", "junius");
  assert.notEqual(nameA, nameB);
  assert.ok(nameA.length <= 64 && nameB.length <= 64);
  p.track("A", "browser", nameA);
  assert.equal(p.endTurn("A").size, 0);
  p.beginTurn("A");
  assert.equal(p.authorize("A", "2", "browser", "x", context()), true);
  p.interrupt("A", "browser");
  assert.equal(p.authorize("A", "2", "browser", "x", context()), false);
  assert.deepEqual(p.endTurn("A").get("browser"), [nameA]);
  p.beginTurn("A");
  assert.notEqual(p.authorize("A", "3", "browser", "x", context()), true);
});
