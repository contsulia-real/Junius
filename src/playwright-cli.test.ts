import assert from "node:assert/strict";
import {
  mkdir,
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
  resolvePlaywrightCliLauncher,
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
      "const delayMs = Number(process.env.JUNIUS_TEST_PLAYWRIGHT_DELAY_MS || '0');",
      "if (delayMs > 0 && args.at(-1) === 'snapshot') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs); }",
      "if (process.env.JUNIUS_TEST_PLAYWRIGHT_FAIL_COMMAND === args.at(-1)) { process.stderr.write('forced playwright failure'); process.exit(1); }",
      "process.stdout.write(JSON.stringify(args));",
      "",
    ].join("\n"),
    "utf8",
  );

  const service = new PlaywrightCliService(
    {
      ...process.env,
      PATH: root,
      JUNIUS_PROJECT_ROOT: undefined,
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

test(
  "playwright-cli resolves the Junius-installed CLI before PATH",
  async () => {
    const root = await mkdtemp(
      join(
        tmpdir(),
        "junius-playwright-installed-",
      ),
    );

    try {
      const cliDirectory = join(
        root,
        "node_modules",
        "@playwright",
        "cli",
      );
      await mkdir(
        cliDirectory,
        { recursive: true },
      );
      const entryPath = join(
        cliDirectory,
        "playwright-cli.js",
      );
      await writeFile(
        entryPath,
        "process.exit(0);\n",
        "utf8",
      );

      const launcher =
        resolvePlaywrightCliLauncher(
          {
            JUNIUS_PROJECT_ROOT:
              root,
            PATH: "",
          },
          process.execPath,
        );

      assert.equal(
        launcher?.executable,
        process.execPath,
      );
      assert.deepEqual(
        launcher?.fixedArgs,
        [entryPath],
      );
      assert.equal(
        launcher?.entryPath,
        entryPath,
      );
    } finally {
      await rm(
        root,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);

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

test("playwright-cli Escape interrupt terminates the active command", async () => {
  let controller:
    AbortController | undefined;
  const interrupt = {
    arm() {
      controller =
        new AbortController();
      return {
        signal:
          controller.signal,
        release() {},
      };
    },
  };
  const f = await fixture(
    { interrupt },
    {
      JUNIUS_TEST_PLAYWRIGHT_DELAY_MS:
        "10000",
    },
  );

  try {
    const startedAt = Date.now();
    const pending = f.service.run(
      "browser",
      "snapshot",
      [],
      true,
    );

    await waitFor(
      () =>
        controller !==
        undefined,
    );
    controller!.abort(
      new Error(
        "user_interrupted",
      ),
    );

    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof
          PlaywrightCliError &&
        error.code ===
          "user_interrupted",
    );
    assert.ok(
      Date.now() - startedAt <
        3_000,
    );
  } finally {
    await f.dispose();
  }
});

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
      true,
    );
    assert.equal(result.exitCode, 0);
  } finally {
    await f.dispose();
  }
});

test("playwright-cli requires explicit current-task authorization before browser access", async () => {
  const f = await fixture();

  try {
    await assert.rejects(
      f.service.run(
        "browser",
        "snapshot",
        [],
      ),
      (error: unknown) =>
        error instanceof
          PlaywrightCliError &&
        error.code ===
          "authorization_required",
    );
    assert.deepEqual(
      await f.calls(),
      [],
    );

    await assert.rejects(
      f.service.run(
        "cleanup-only",
        "close",
        [],
      ),
      (error: unknown) =>
        error instanceof
          PlaywrightCliError &&
        error.code ===
          "authorization_required",
    );
    assert.deepEqual(
      await f.calls(),
      [],
    );

    await f.service.run(
      "cleanup-only",
      "close",
      [],
      true,
    );

    await f.service.run(
      "browser",
      "open",
      [],
      true,
    );

    await f.service.run(
      "browser",
      "snapshot",
      [],
    );

    await assert.rejects(
      f.service.run(
        "browser",
        "snapshot",
        [],
        true,
      ),
      (error: unknown) =>
        error instanceof
          PlaywrightCliError &&
        error.code ===
          "authorization_not_allowed",
    );

    await f.service.run(
      "browser",
      "close",
      [],
    );

    await assert.rejects(
      f.service.run(
        "browser",
        "snapshot",
        [],
      ),
      (error: unknown) =>
        error instanceof
          PlaywrightCliError &&
        error.code ===
          "authorization_required",
    );

    await assert.rejects(
      f.service.run(
        "browser",
        "close",
        [],
      ),
      (error: unknown) =>
        error instanceof
          PlaywrightCliError &&
        error.code ===
          "authorization_required",
    );
  } finally {
    await f.dispose();
  }
});

test("playwright-cli removes managed browser data when the authorized session closes", async () => {
  const f = await fixture();

  try {
    await f.service.run(
      "browser",
      "open",
      [],
      true,
    );

    const managedArtifact =
      join(
        f.root,
        "browser",
        ".playwright-cli",
        "page.yml",
      );
    await mkdir(
      join(
        f.root,
        "browser",
        ".playwright-cli",
      ),
      { recursive: true },
    );
    await writeFile(
      managedArtifact,
      "private browser data",
      "utf8",
    );

    await f.service.run(
      "browser",
      "close",
      [],
    );

    await assert.rejects(
      readFile(
        managedArtifact,
        "utf8",
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT",
    );

    assert.equal(
      (await f.calls()).some(
        (args) =>
          args[0] ===
            "-s=browser" &&
          args.at(-1) ===
            "delete-data",
      ),
      true,
    );
  } finally {
    await f.dispose();
  }
});

test("playwright-cli close failure still ends the authorized session lifecycle", async () => {
  const f = await fixture(
    {},
    {
      JUNIUS_TEST_PLAYWRIGHT_FAIL_COMMAND:
        "close",
    },
  );

  try {
    await f.service.run(
      "browser",
      "open",
      [],
      true,
    );

    await assert.rejects(
      f.service.run(
        "browser",
        "close",
        [],
      ),
      (error: unknown) =>
        error instanceof
          PlaywrightCliError &&
        error.code ===
          "nonzero_exit",
    );

    assert.equal(
      f.service.state()
        .sessionCount,
      0,
    );

    await assert.rejects(
      f.service.run(
        "browser",
        "snapshot",
        [],
      ),
      (error: unknown) =>
        error instanceof
          PlaywrightCliError &&
        error.code ===
          "authorization_required",
    );
  } finally {
    await f.dispose();
  }
});

test("playwright-cli revokes authorization and removes managed artifacts when cleanup partly fails", async () => {
  const f = await fixture(
    {},
    {
      JUNIUS_TEST_PLAYWRIGHT_FAIL_COMMAND:
        "delete-data",
    },
  );

  try {
    await f.service.run(
      "browser",
      "open",
      [],
      true,
    );

    const managedArtifact =
      join(
        f.root,
        "browser",
        ".playwright-cli",
        "page.yml",
      );
    await mkdir(
      join(
        f.root,
        "browser",
        ".playwright-cli",
      ),
      { recursive: true },
    );
    await writeFile(
      managedArtifact,
      "private browser data",
      "utf8",
    );

    await assert.rejects(
      f.service.run(
        "browser",
        "close",
        [],
      ),
      (error: unknown) =>
        error instanceof
          PlaywrightCliError &&
        error.code ===
          "data_cleanup_failed",
    );

    await assert.rejects(
      readFile(
        managedArtifact,
        "utf8",
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT",
    );

    await assert.rejects(
      f.service.run(
        "browser",
        "snapshot",
        [],
      ),
      (error: unknown) =>
        error instanceof
          PlaywrightCliError &&
        error.code ===
          "authorization_required",
    );
  } finally {
    await f.dispose();
  }
});

test("playwright-cli keeps managed browser data when retention is explicitly enabled", async () => {
  const f = await fixture(
    {},
    {
      JUNIUS_BROWSER_RETAIN_DATA:
        "1",
    },
  );

  try {
    assert.equal(
      f.service.state()
        .retainData,
      true,
    );
    await f.service.run(
      "browser",
      "open",
      [],
      true,
    );

    const managedArtifact =
      join(
        f.root,
        "browser",
        ".playwright-cli",
        "page.yml",
      );
    await mkdir(
      join(
        f.root,
        "browser",
        ".playwright-cli",
      ),
      { recursive: true },
    );
    await writeFile(
      managedArtifact,
      "private browser data",
      "utf8",
    );

    await f.service.run(
      "browser",
      "close",
      [],
    );

    assert.equal(
      await readFile(
        managedArtifact,
        "utf8",
      ),
      "private browser data",
    );
    assert.equal(
      (await f.calls()).some(
        (args) =>
          args[0] ===
            "-s=browser" &&
          args.at(-1) ===
            "delete-data",
      ),
      false,
    );
  } finally {
    await f.dispose();
  }
});

test("playwright-cli injects only the named session and preserves CLI arguments", async () => {
  const f = await fixture();
  try {
    const snapshot = await f.service.run(
      "browser",
      "snapshot",
      [],
      true,
    );
    assert.deepEqual(
      JSON.parse(snapshot.stdout),
      [
        "-s=browser",
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
    await f.service.run(
      "idle",
      "snapshot",
      [],
      true,
    );
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
    await f.service.run(
      "active",
      "snapshot",
      [],
      true,
    );
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
    await f.service.run(
      "one",
      "snapshot",
      [],
      true,
    );
    await f.service.run(
      "two",
      "snapshot",
      [],
      true,
    );
    await f.service.run(
      "three",
      "snapshot",
      [],
      true,
    );

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
    await f.service.run(
      "one",
      "snapshot",
      [],
      true,
    );
    await f.service.run(
      "two",
      "snapshot",
      [],
      true,
    );
    await f.service.close();

    assert.equal(f.service.state().sessionCount, 0);
    await assert.rejects(
      f.service.run("browser", "snapshot", []),
      (error: unknown) =>
        error instanceof PlaywrightCliError &&
        error.code === "playwright_cli_closing",
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

test("playwright-cli forwards arbitrary commands and arguments unchanged", async () => {
  const f = await fixture();
  try {
    const result = await f.service.run(
      "browser",
      "run-code",
      [
        "async page => await page.title()",
        "--future-option",
        "value",
      ],
      true,
    );

    assert.deepEqual(
      JSON.parse(result.stdout),
      [
        "-s=browser",
        "run-code",
        "async page => await page.title()",
        "--future-option",
        "value",
      ],
    );
  } finally {
    await f.dispose();
  }
});

test("playwright-cli still validates Junius session identifiers", async () => {
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

