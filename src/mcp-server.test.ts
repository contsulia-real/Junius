import assert from "node:assert/strict";
import test from "node:test";
import { formatRunCommandResult } from "./mcp-server.js";

test("formatRunCommandResult preserves failed execution diagnostics", () => {
  const text = formatRunCommandResult({
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
  });

  assert.deepEqual(JSON.parse(text), {
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
});

test("formatRunCommandResult preserves authorization errors without fake execution", () => {
  const text = formatRunCommandResult({
    ok: false,
    workspace: "weave",
    key: "pnpm",
    code: "arguments_not_allowed_by_workspace",
    message: "Arguments are not allowed.",
  });

  assert.deepEqual(JSON.parse(text), {
    ok: false,
    workspace: "weave",
    key: "pnpm",
    code: "arguments_not_allowed_by_workspace",
    message: "Arguments are not allowed.",
  });
});
