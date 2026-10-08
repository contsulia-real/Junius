import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpObservabilityStore } from "./mcp-observability.js";
import { McpObservabilityPersistence } from "./mcp-observability-persistence.js";

test("persisted observations retain prompt titles, bounded tool arguments and event inputs across a restart", () => {
  const root = mkdtempSync(join(tmpdir(), "junius-observation-"));
  try {
    const store = new McpObservabilityStore({ rootPath: root });
    store.beginTurn("chat", [
      { type: "text", text: "Show the actual user request" },
      { type: "file" },
    ]);
    const call = store.beginToolCall("run_command", { args: ["node", "--version"] }, "chat");
    store.finishToolCall(call, "succeeded");
    store.endTurn("chat");

    const disk = readFileSync(join(root, readdirSync(root)[0]!), "utf8");
    assert.match(disk, /Show the actual user request \[File\]/u);
    assert.match(disk, /"node"/u);
    assert.match(disk, /"--version"/u);
    assert.doesNotMatch(disk, /\[private input omitted\]/u);

    const restored = new McpObservabilityStore({ rootPath: root }).snapshot("chat").turns[0]!;
    assert.equal(restored.title, "Show the actual user request [File]");
    assert.deepEqual(restored.tools[0]!.calls[0]!.input, { args: ["node", "--version"] });
    assert.deepEqual(
      restored.events.find((event) => event.kind === "tool_started")?.input,
      { args: ["node", "--version"] },
    );

    store.deleteSession("chat");
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("startup preserves valid observation history and expires aged files", () => {
  const root = mkdtempSync(join(tmpdir(), "junius-retained-observation-"));
  try {
    const old = new McpObservabilityStore({ rootPath: root });
    old.beginTurn("chat", [{ type: "text", text: "Keep this earlier prompt" }]);
    const call = old.beginToolCall("run_command", { args: ["example"] }, "chat");
    old.finishToolCall(call, "succeeded");
    const name = readdirSync(root)[0]!;
    const path = join(root, name);
    const original = readFileSync(path, "utf8");

    new McpObservabilityPersistence(root);
    assert.equal(readFileSync(path, "utf8"), original);

    const expired = JSON.parse(original);
    expired.updatedAt = "2020-01-01T00:00:00.000Z";
    writeFileSync(path, JSON.stringify(expired));
    new McpObservabilityPersistence(root);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
