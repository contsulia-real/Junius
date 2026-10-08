import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readDefaultJuniusPrompt,
  readJuniusPrompt,
  resolveJuniusPromptRoot,
} from "./junius-prompt-store.js";

test("packaged Browser/Desktop rules describe direct execution without a Junius consent dialog", () => {
  for (const name of ["core", "browser", "desktop"] as const) {
    const rule = readDefaultJuniusPrompt(name).text;
    assert.match(rule, /direct|directly/u, name);
    assert.doesNotMatch(rule, /permissionRequired|junius_computer_permission_request|MCP App/u, name);
  }
});

test("reading a persistent prompt never migrates, rewrites, or creates backups", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "junius-prompt-read-"));
  try {
    const environment = { LOCALAPPDATA: localAppData };
    const root = resolveJuniusPromptRoot(environment);
    mkdirSync(root, { recursive: true });
    const original = "# Our Junius prompt\n\n## Authorization boundary\n\nKeep the existing text exactly.\n";
    const path = join(root, "browser.md");
    writeFileSync(path, original, "utf8");

    for (let i = 0; i < 2; i++) {
      const prompt = readJuniusPrompt("browser", environment);
      assert.equal(prompt.source, "custom");
      assert.equal(prompt.text, original);
      assert.equal(readFileSync(path, "utf8"), original);
      assert.deepEqual(readdirSync(root), ["browser.md"]);
    }
  } finally {
    rmSync(localAppData, { recursive: true, force: true });
  }
});
