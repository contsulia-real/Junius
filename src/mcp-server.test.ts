import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatRunCommandResult } from "./mcp-server.js";
import { JUNIUS_VERSION } from "./project-version.js";

test("Junius runtime version follows package.json", () => {
  const packageJson = JSON.parse(
    readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    ),
  ) as { version?: unknown };

  assert.equal(
    JUNIUS_VERSION,
    packageJson.version,
  );
});

test("formatRunCommandResult preserves execution diagnostics without inventing execution data", () => {
  const failedExecution = JSON.parse(
    formatRunCommandResult({
      ok: false,
      workspace: "weave",
      key: "pnpm",
      code: "nonzero_exit",
      message: "Process exited with code 2.",
      execution: {
        ok: false,
        code: "nonzero_exit",
        message: "Process exited with code 2.",
        exitCode: 2,
        signal: null,
        stdout: "stdout-details",
        stderr: "stderr-details",
        durationMs: 123,
      },
    }),
  );

  assert.deepEqual(failedExecution, {
    ok: false,
    workspace: "weave",
    key: "pnpm",
    code: "nonzero_exit",
    message: "Process exited with code 2.",
    execution: {
      exitCode: 2,
      signal: null,
      stdout: "stdout-details",
      stderr: "stderr-details",
      durationMs: 123,
    },
  });

  const authorizationFailure = JSON.parse(
    formatRunCommandResult({
      ok: false,
      workspace: "weave",
      key: "pnpm",
      code: "arguments_not_allowed_by_workspace",
      message: "Arguments are not allowed.",
    }),
  );

  assert.deepEqual(authorizationFailure, {
    ok: false,
    workspace: "weave",
    key: "pnpm",
    code: "arguments_not_allowed_by_workspace",
    message: "Arguments are not allowed.",
  });
});
