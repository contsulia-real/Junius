import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PlaywrightCliError,
  PlaywrightCliService,
} from "./playwright-cli.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "junius-playwright-cli-"));
  const launcher = join(root, "playwright-cli.js");

  await writeFile(
    launcher,
    "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n",
    "utf8",
  );

  const service = new PlaywrightCliService({
    ...process.env,
    PATH: "",
    JUNIUS_PLAYWRIGHT_CLI_PATH: launcher,
    JUNIUS_BROWSER_STATE_PATH: root,
  });

  return {
    service,
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("playwright-cli snapshot uses named session and raw output", async () => {
  const f = await fixture();
  try {
    const result = await f.service.run(
      "browser",
      "snapshot",
      [],
    );

    assert.deepEqual(JSON.parse(result.stdout), [
      "-s=browser",
      "--raw",
      "snapshot",
    ]);
  } finally {
    await f.dispose();
  }
});

test("playwright-cli open defaults to a persistent CLI profile", async () => {
  const f = await fixture();
  try {
    const result = await f.service.run(
      "browser",
      "open",
      ["https://example.com"],
    );

    assert.deepEqual(JSON.parse(result.stdout), [
      "-s=browser",
      "open",
      "https://example.com",
      "--persistent",
    ]);
  } finally {
    await f.dispose();
  }
});

test("playwright-cli adapter rejects eval", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.run(
        "browser",
        "eval" as never,
        ["document.title"],
      ),
      (error: unknown) =>
        error instanceof PlaywrightCliError &&
        error.code === "command_not_allowed",
    );
  } finally {
    await f.dispose();
  }
});

test("playwright-cli adapter validates refs for click", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.run(
        "browser",
        "click",
        ["#arbitrary-selector"],
      ),
      (error: unknown) =>
        error instanceof PlaywrightCliError &&
        error.code === "arguments_not_allowed",
    );
  } finally {
    await f.dispose();
  }
});

test("playwright-cli adapter rejects invalid session names", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.run(
        "../browser",
        "snapshot",
        [],
      ),
      (error: unknown) =>
        error instanceof PlaywrightCliError &&
        error.code === "invalid_session",
    );
  } finally {
    await f.dispose();
  }
});
