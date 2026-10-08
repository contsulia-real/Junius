import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpObservabilityStore } from "./mcp-observability.js";
import { McpObservabilityPersistence } from "./mcp-observability-persistence.js";

test("persisted observations omit private prompts and arguments while live turns still work", () => {
  const root = mkdtempSync(join(tmpdir(), "junius-private-observation-"));
  try {
    const store = new McpObservabilityStore({ rootPath: root });
    store.beginTurn("chat", [{ type: "text", text: "PRIVATE_SYNTHETIC_TITLE" + "x".repeat(10000) }]);
    const call = store.beginToolCall("run_command", { password: "PRIVATE_SYNTHETIC_SECRET", args: ["PRIVATE_ARG"] }, "chat");
    store.finishToolCall(call, "succeeded");
    store.endTurn("chat");
    assert.match(store.snapshot("chat").turns[0]!.title, /PRIVATE_SYNTHETIC_TITLE/u);
    const disk = readFileSync(join(root, readdirSync(root)[0]!), "utf8");
    assert.doesNotMatch(disk, /PRIVATE_SYNTHETIC_TITLE|PRIVATE_SYNTHETIC_SECRET|PRIVATE_ARG/u);
    const restored = new McpObservabilityStore({ rootPath: root }).snapshot("chat").turns[0]!;
    assert.equal(restored.title, "[private input omitted]");
    assert.equal(restored.tools[0]!.calls[0]!.input, "[private input omitted]");
    store.deleteSession("chat");
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("legacy observation files are scrubbed on startup and aged files expire", () => {
  const root = mkdtempSync(join(tmpdir(), "junius-legacy-observation-"));
  try {
    const old = new McpObservabilityStore({ rootPath: root });
    old.beginTurn("chat", [{ type: "text", text: "PRIVATE_LEGACY_TITLE" }]);
    const call = old.beginToolCall("run_command", { secret: "PRIVATE_LEGACY_ARG" }, "chat");
    old.finishToolCall(call, "succeeded");
    const name = readdirSync(root)[0]!;
    const path = join(root, name);
    const original = JSON.parse(readFileSync(path, "utf8"));
    original.snapshot.turns[0].title = "PRIVATE_LEGACY_TITLE";
    original.snapshot.turns[0].tools[0].calls[0].input = { secret: "PRIVATE_LEGACY_ARG" };
    writeFileSync(path, JSON.stringify(original));
    new McpObservabilityPersistence(root);
    assert.doesNotMatch(readFileSync(path, "utf8"), /PRIVATE_LEGACY_TITLE|PRIVATE_LEGACY_ARG/u);
    const expired = JSON.parse(readFileSync(path, "utf8"));
    expired.updatedAt = "2020-01-01T00:00:00.000Z";
    writeFileSync(path, JSON.stringify(expired));
    new McpObservabilityPersistence(root);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
