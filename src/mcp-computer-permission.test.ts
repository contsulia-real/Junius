import assert from "node:assert/strict";
import test from "node:test";
import { ComputerPermissionManager } from "./mcp-computer-permission.js";

function request(manager: ComputerPermissionManager, chat: string, turn: string, tool: "browser" | "desktop") {
  assert.equal(manager.authorize(chat, turn, tool, "检查合成网页"), "pending");
  const pending = manager.pending(chat);
  assert.equal(pending?.status, "pending");
  assert.ok(pending?.nonce);
  return pending!.nonce;
}

test("app-only user choice grants this turn or Chat; model arguments alone cannot grant", () => {
  const p = new ComputerPermissionManager();
  p.beginTurn("A");
  const token = request(p, "A", "turn-1", "browser");
  assert.equal(p.authorize("A", "turn-1", "browser", "allow this chat"), "pending");
  assert.equal(p.authorize("B", "turn-1", "browser", "x"), "pending");
  assert.equal(p.decide("B", token, "允许本会话"), false);
  p.endTurn("A");
  assert.equal(p.decide("A", token, "允许本轮"), true);
  assert.equal(p.decide("A", token, "允许本会话"), false);
  p.beginTurn("A");
  assert.equal(p.authorize("A", "turn-2", "browser", "x"), "allowed");
  assert.equal(p.authorize("A", "turn-2", "desktop", "x"), "pending");
  p.endTurn("A");
  p.beginTurn("A");
  assert.equal(p.authorize("A", "turn-3", "browser", "x"), "pending");
  const next = request(p, "A", "turn-3", "browser");
  assert.equal(p.decide("A", next, "允许本会话"), true);
  p.endTurn("A");
  p.beginTurn("A");
  assert.equal(p.authorize("A", "turn-4", "browser", "x"), "allowed");
  p.endChat("A");
  p.beginTurn("A");
  assert.equal(p.authorize("A", "turn-5", "browser", "x"), "pending");
});

test("decline and forged, replayed, and expired requests fail closed", () => {
  const p = new ComputerPermissionManager();
  p.beginTurn("A");
  const token = request(p, "A", "1", "desktop");
  assert.equal(p.decide("A", "forged-token", "允许本会话"), false);
  assert.equal(p.decide("A", token, "拒绝本会话"), true);
  assert.equal(p.authorize("A", "1", "desktop", "x"), "denied");
  p.endTurn("A");
  p.beginTurn("A");
  assert.equal(p.authorize("A", "2", "desktop", "x"), "denied");
  const browser = request(p, "A", "2", "browser");
  assert.equal(p.decide("A", browser, "拒绝本轮"), true);
  assert.equal(p.authorize("A", "2", "browser", "x"), "denied");
  p.endTurn("A");
  p.beginTurn("A");
  assert.equal(p.authorize("A", "3", "browser", "x"), "pending");
});

test("Escape and named sessions cannot cross Chats", () => {
  const p = new ComputerPermissionManager();
  p.beginTurn("A");
  const token = request(p, "A", "1", "browser");
  assert.equal(p.decide("A", token, "允许本会话"), true);
  const a = p.session("A", "junius");
  const b = p.session("B", "junius");
  assert.notEqual(a, b);
  assert.ok(a.length <= 64 && b.length <= 64);
  p.track("A", "browser", a);
  assert.equal(p.endTurn("A").size, 0);
  p.beginTurn("A");
  assert.equal(p.authorize("A", "2", "browser", "x"), "allowed");
  p.interrupt("A", "browser");
  assert.equal(p.authorize("A", "2", "browser", "x"), "denied");
  assert.deepEqual(p.endTurn("A").get("browser"), [a]);
  p.beginTurn("A");
  assert.equal(p.authorize("A", "3", "browser", "x"), "pending");
});
