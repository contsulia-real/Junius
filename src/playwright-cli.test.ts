import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
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

async function fixture(
  options: ConstructorParameters<
    typeof PlaywrightCliService
  >[2] = {},
  environmentOverrides: NodeJS.ProcessEnv = {},
) {
  const root = await mkdtemp(join(tmpdir(), "junius-playwright-cli-"));
  const launcher = join(root, "playwright-cli.js");
  const logPath = join(root, "calls.log");

  await writeFile(
    launcher,
    [
      "const fs = require('node:fs');",
      `const args = process.argv.slice(2);`,
      `fs.appendFileSync(${JSON.stringify("__LOG_PATH__")}.replace('__LOG_PATH__', process.env.JUNIUS_TEST_PLAYWRIGHT_LOG), JSON.stringify(args) + '\\n');`,
      "process.stdout.write(JSON.stringify(args));",
      "",
    ].join("\n"),
    "utf8",
  );

  const service = new PlaywrightCliService(
    {
      ...process.env,
      PATH: root,
      JUNIUS_BROWSER_STATE_PATH: root,
      JUNIUS_TEST_PLAYWRIGHT_LOG: logPath,
      ...environmentOverrides,
    },
    process.execPath,
    options,
  );

  return {
    root,
    logPath,
    service,
    async calls() {
      try {
        return (await readFile(logPath, "utf8"))
          .trim()
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]);
      } catch {
        return [] as string[][];
      }
    },
    async dispose() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition_not_met_before_timeout");
}

test("playwright-cli strips inherited Node preload environment", async () => {
  const f = await fixture(
    {},
    {
      NODE_OPTIONS:
        "--require=definitely-missing-junius-module",
      node_path: "C:\\evil\\modules",
    },
  );

  try {
    const result = await f.service.run(
      "browser",
      "snapshot",
      [],
    );
    assert.equal(result.exitCode, 0);
  } finally {
    await f.dispose();
  }
});

test("playwright-cli maps core commands to bounded CLI arguments", async () => {
  const f = await fixture();
  try {
    const snapshot = await f.service.run(
      "browser",
      "snapshot",
      [],
    );
    assert.deepEqual(
      JSON.parse(snapshot.stdout),
      [
        "-s=browser",
        "--raw",
        "snapshot",
      ],
    );

    const opened = await f.service.run(
      "browser",
      "open",
      ["https://example.com"],
    );
    assert.deepEqual(
      JSON.parse(opened.stdout),
      [
        "-s=browser",
        "open",
        "https://example.com",
        "--persistent",
        "--headed",
      ],
    );
  } finally {
    await f.dispose();
  }
});

test("playwright-cli automatically closes idle named sessions", async () => {
  const f = await fixture({
    sessionIdleMs: 40,
    maxSessions: 8,
  });

  try {
    await f.service.run("idle", "snapshot", []);
    assert.equal(f.service.state().sessionCount, 1);

    await waitFor(
      () => f.service.state().sessionCount === 0,
    );
    await waitFor(async () =>
      (await f.calls()).some(
        (args) =>
          args[0] === "-s=idle" &&
          args.at(-1) === "close",
      ),
    );
  } finally {
    await f.dispose();
  }
});

test("playwright-cli activity refreshes named-session idle expiry", async () => {
  const f = await fixture({
    sessionIdleMs: 80,
    maxSessions: 8,
  });

  try {
    await f.service.run("active", "snapshot", []);
    await new Promise((resolve) => setTimeout(resolve, 45));
    await f.service.run("active", "snapshot", []);
    await new Promise((resolve) => setTimeout(resolve, 45));

    assert.equal(f.service.state().sessionCount, 1);

    await waitFor(
      () => f.service.state().sessionCount === 0,
    );
  } finally {
    await f.dispose();
  }
});

test("playwright-cli bounds tracked named sessions and closes the oldest", async () => {
  const f = await fixture({
    sessionIdleMs: 60_000,
    maxSessions: 2,
  });

  try {
    await f.service.run("one", "snapshot", []);
    await f.service.run("two", "snapshot", []);
    await f.service.run("three", "snapshot", []);

    assert.equal(f.service.state().sessionCount, 2);
    await waitFor(async () =>
      (await f.calls()).some(
        (args) =>
          args[0] === "-s=one" &&
          args.at(-1) === "close",
      ),
    );
  } finally {
    await f.dispose();
  }
});

test("playwright-cli close shuts down all tracked named sessions", async () => {
  const f = await fixture({
    sessionIdleMs: 60_000,
    maxSessions: 8,
  });

  try {
    await f.service.run("one", "snapshot", []);
    await f.service.run("two", "snapshot", []);
    await f.service.close();

    assert.equal(f.service.state().sessionCount, 0);
    await assert.rejects(
      f.service.run("browser", "snapshot", []),
      (error: unknown) =>
        error instanceof PlaywrightCliError &&
        error.code === "playwright_cli_disabled",
    );
    const calls = await f.calls();
    assert.equal(
      calls.some(
        (args) =>
          args[0] === "-s=one" &&
          args.at(-1) === "close",
      ),
      true,
    );
    assert.equal(
      calls.some(
        (args) =>
          args[0] === "-s=two" &&
          args.at(-1) === "close",
      ),
      true,
    );
  } finally {
    await f.dispose();
  }
});

test("playwright-cli rejects unsupported commands and invalid session identifiers", async () => {
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

test("playwright-cli disable closes tracked sessions and supports re-enable", async () => {
  const f = await fixture({
    sessionIdleMs: 60_000,
    maxSessions: 8,
  });

  try {
    await f.service.run("browser", "snapshot", []);
    assert.equal(f.service.state().sessionCount, 1);

    await f.service.setEnabled(false);
    assert.equal(f.service.state().enabled, false);
    assert.equal(f.service.state().active, false);
    assert.equal(f.service.state().sessionCount, 0);

    await assert.rejects(
      f.service.run("browser", "snapshot", []),
      (error: unknown) =>
        error instanceof PlaywrightCliError &&
        error.code === "playwright_cli_disabled",
    );

    const calls = await f.calls();
    assert.equal(
      calls.some(
        (args) =>
          args[0] === "-s=browser" &&
          args.at(-1) === "close",
      ),
      true,
    );

    await f.service.setEnabled(true);
    const resumed = await f.service.run(
      "browser",
      "snapshot",
      [],
    );
    assert.equal(resumed.exitCode, 0);
    assert.equal(f.service.state().active, true);
    assert.equal(f.service.state().sessionCount, 1);
  } finally {
    await f.dispose();
  }
});

