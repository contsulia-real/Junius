import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatRunCommandResult } from "./mcp-server.js";
import { JUNIUS_VERSION } from "./project-version.js";

test(
  "Junius runtime version follows package.json",
  () => {
    const packageJson =
      JSON.parse(
        readFileSync(
          new URL(
            "../package.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as {
        version?: unknown;
      };

    assert.equal(
      packageJson.version,
      "0.1.7-alpha",
    );
    assert.equal(
      JUNIUS_VERSION,
      packageJson.version,
    );
  },
);

test(
  "formatRunCommandResult preserves executable arguments and execution diagnostics",
  () => {
    const failed =
      JSON.parse(
        formatRunCommandResult({
          ok: false,
          workspace: "weave",
          executable: "pnpm",
          args: [
            "run",
            "check",
          ],
          code:
            "nonzero_exit",
          message:
            "Process exited with code 2.",
          execution: {
            ok: false,
            code:
              "nonzero_exit",
            message:
              "Process exited with code 2.",
            exitCode: 2,
            signal: null,
            stdout:
              "stdout-details",
            stderr:
              "stderr-details",
            durationMs: 123,
          },
        }),
      );

    assert.deepEqual(
      failed,
      {
        ok: false,
        workspace: "weave",
        executable: "pnpm",
        args: [
          "run",
          "check",
        ],
        code:
          "nonzero_exit",
        message:
          "Process exited with code 2.",
        execution: {
          exitCode: 2,
          signal: null,
          stdout:
            "stdout-details",
          stderr:
            "stderr-details",
          durationMs: 123,
        },
      },
    );

    const missing =
      JSON.parse(
        formatRunCommandResult({
          ok: false,
          workspace: "weave",
          executable: "node",
          args: [],
          code:
            "workspace_not_registered",
          message:
            "Workspace is not registered.",
        }),
      );

    assert.deepEqual(
      missing,
      {
        ok: false,
        workspace: "weave",
        executable: "node",
        args: [],
        code:
          "workspace_not_registered",
        message:
          "Workspace is not registered.",
      },
    );
  },
);
