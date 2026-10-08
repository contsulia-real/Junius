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

test("packaged computer-use rules describe the actual MCP App approval handoff", () => {
  for (const name of ["core", "browser", "desktop"] as const) {
    const rule = readDefaultJuniusPrompt(name).text;
    assert.match(rule, /MCP App/u, name);
    assert.match(rule, /permissionRequired/u, name);
    assert.match(rule, /user.*(?:select|click|choice)|用户.*(?:选择|点击)/iu, name);
    assert.match(rule, /(?:retry|call.*again|再次调用|重试)/iu, name);
    assert.equal(rule.includes("elicitation/create"), false, name);
  }
});

test("browser permission applies to indirect automation and prohibits silently installing Playwright", () => {
  for (const name of ["core", "browser", "engineering"] as const) {
    const rule = readDefaultJuniusPrompt(name).text;
    assert.match(rule, /run_command|run_commands|start_job/u, name);
    assert.match(rule, /Playwright|Puppeteer|Selenium/u, name);
    assert.match(rule, /install|dependency|dependencies/u, name);
    assert.match(rule, /explicitly requests|explicitly asks|explicit user/u, name);
    assert.match(rule, /permission|consent|authorization/u, name);
    assert.match(rule, /bypass|alternate/u, name);
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
