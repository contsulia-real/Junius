import assert from "node:assert/strict";
import test from "node:test";
import { ComputerSessionManager } from "./mcp-computer-sessions.js";

test("Browser/Desktop sessions remain isolated between Chats", () => {
  const sessions = new ComputerSessionManager();
  const a = sessions.session("A", "junius");
  const b = sessions.session("B", "junius");
  assert.notEqual(a, b);
  assert.ok(a.length <= 64 && b.length <= 64);
  sessions.track("A", "browser", a);
  sessions.track("B", "browser", b);
  sessions.track("A", "desktop", a);
  assert.equal(sessions.isTracked("A", "browser", a), true);
  assert.equal(sessions.isTracked("B", "browser", a), false);
  assert.deepEqual(sessions.endTurn("A").get("desktop"), [a]);
  assert.equal(sessions.isTracked("A", "browser", a), true);
  assert.equal(sessions.isTracked("A", "desktop", a), false);
  assert.deepEqual(sessions.endChat("A").get("browser"), [a]);
  assert.equal(sessions.isTracked("B", "browser", b), true);
});

test("Escape interrupts only the current Chat and tool until the next turn", () => {
  const sessions = new ComputerSessionManager();
  sessions.beginTurn("A");
  sessions.beginTurn("B");
  sessions.interrupt("A", "browser");
  assert.equal(sessions.wasInterrupted("A", "browser"), true);
  assert.equal(sessions.wasInterrupted("A", "desktop"), false);
  assert.equal(sessions.wasInterrupted("B", "browser"), false);
  sessions.beginTurn("A");
  assert.equal(sessions.wasInterrupted("A", "browser"), false);
});
