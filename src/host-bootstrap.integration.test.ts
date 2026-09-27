import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

async function freePort(): Promise<number> {
  const server: Server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  server.close();
  await once(server, "close");
  return port;
}

interface BootstrapRun {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runBootstrap(
  root: string,
  checkResult: "pass" | "fail",
  forceValidate: boolean,
): Promise<BootstrapRun> {
  const mcpPort = await freePort();
  const adminPort = await freePort();
  const fakeBin = join(root, "bin");
  const fakePnpm = join(fakeBin, "pnpm.js");
  const workspaceRoot = join(root, "workspace");
  const runtimeRoot = join(root, "runtime");

  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    join(fakeBin, "pnpm"),
    "not-a-native-executable\n",
    "utf8",
  );
  await writeFile(
    fakePnpm,
    `
const result = process.env.JUNIUS_BOOTSTRAP_TEST_CHECK_RESULT;
process.exit(result === "pass" ? 0 : 1);
`,
    "utf8",
  );

  const child = spawn(
    process.execPath,
    [join(process.cwd(), "scripts", "host-bootstrap.mjs")],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: [
          fakeBin,
          process.env.PATH ?? "",
        ].filter(Boolean).join(delimiter),
        JUNIUS_BOOTSTRAP_TEST_CHECK_RESULT: checkResult,
        JUNIUS_BOOTSTRAP_TEST_EXIT_AFTER_HEALTH: "1",
        ...(forceValidate
          ? {
              JUNIUS_BOOTSTRAP_TEST_FORCE_VALIDATE: "1",
            }
          : {}),
        JUNIUS_RUNTIME_ROOT: runtimeRoot,
        JUNIUS_MCP_PORT: String(mcpPort),
        JUNIUS_ADMIN_PORT: String(adminPort),
        JUNIUS_WORKSPACE_ID: "bootstrap-test",
        JUNIUS_WORKSPACE_ROOT: workspaceRoot,
        JUNIUS_WORKSPACE_STATE_PATH: join(
          root,
          "workspace-state.json",
        ),
        JUNIUS_MACHINE_CAPABILITY_STATE_PATH: join(
          root,
          "machine-capability-state.json",
        ),
        JUNIUS_BROWSER_STATE_PATH: join(root, "browser"),
        JUNIUS_WORKER_ROLLBACK_MS: "1000",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const result = await Promise.race([
    once(child, "exit").then(
      ([exitCode, signal]) => ({
        exitCode: exitCode as number | null,
        signal: signal as NodeJS.Signals | null,
      }),
    ),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("bootstrap_timeout")),
        30_000,
      );
    }),
  ]);

  return {
    ...result,
    stdout,
    stderr,
  };
}

test("manual bootstrap promotes a validated release and falls back to last-known-good on failed validation", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "junius-bootstrap-"),
  );

  try {
    const first = await runBootstrap(
      root,
      "pass",
      false,
    );

    assert.equal(
      first.exitCode,
      0,
      first.stderr || first.stdout,
    );
    assert.match(
      first.stderr,
      /promoted validated release/u,
    );

    const currentPath = join(
      root,
      "runtime",
      "current.json",
    );
    const current = JSON.parse(
      await readFile(currentPath, "utf8"),
    ) as {
      releaseId: string;
      fingerprint: string;
    };

    assert.equal(typeof current.releaseId, "string");
    assert.equal(current.releaseId.length > 0, true);
    assert.equal(typeof current.fingerprint, "string");

    const stableBootstrapPath = join(
      root,
      "runtime",
      "bootstrap",
      "host-bootstrap.mjs",
    );
    const promotedBootstrap = await readFile(
      stableBootstrapPath,
      "utf8",
    );
    const liveBootstrap = await readFile(
      join(
        process.cwd(),
        "scripts",
        "host-bootstrap.mjs",
      ),
      "utf8",
    );
    assert.equal(promotedBootstrap, liveBootstrap);

    const unchanged = await runBootstrap(
      root,
      "fail",
      false,
    );

    assert.equal(
      unchanged.exitCode,
      0,
      unchanged.stderr || unchanged.stdout,
    );
    assert.match(
      unchanged.stderr,
      new RegExp(
        `source matches validated release ${current.releaseId}`,
        "u",
      ),
    );
    assert.doesNotMatch(
      unchanged.stderr,
      /candidate rejected/u,
    );

    const sentinelBootstrap =
      "// retained validated bootstrap\n";
    await writeFile(
      stableBootstrapPath,
      sentinelBootstrap,
      "utf8",
    );

    const second = await runBootstrap(
      root,
      "fail",
      true,
    );

    assert.equal(
      second.exitCode,
      0,
      second.stderr || second.stdout,
    );
    assert.match(
      second.stderr,
      /candidate rejected: source_check_failed/u,
    );
    assert.match(
      second.stderr,
      new RegExp(
        `falling back to last-known-good release ${current.releaseId}`,
        "u",
      ),
    );

    const afterFallback = JSON.parse(
      await readFile(currentPath, "utf8"),
    ) as {
      releaseId: string;
      fingerprint: string;
    };

    assert.deepEqual(afterFallback, current);
    assert.equal(
      await readFile(stableBootstrapPath, "utf8"),
      sentinelBootstrap,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
