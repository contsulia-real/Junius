import { z } from "zod";
import type { RunCommandResult } from "./run-command.js";
import { JobManagerError } from "./job-manager.js";
import { WorkspaceFileError } from "./workspace-files.js";
import { PlaywrightCliError } from "./playwright-cli.js";
import { DesktopComputerUseError } from "./desktop-computer-use.js";

export const stableIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const workspacePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .describe("Workspace-relative path. Absolute paths are not accepted.");

export const runCommandInputSchema = z.object({
  workspace: stableIdSchema.describe(
    "Registered Junius Workspace ID. It selects the process working directory.",
  ),
  executable: z
    .string()
    .min(1)
    .max(4_096)
    .describe(
      "Executable name or path to launch directly. Junius does not apply an executable allowlist.",
    ),
  args: z
    .array(
      z.string().max(
        65_536,
      ),
    )
    .max(256)
    .default([])
    .describe(
      "Argument vector passed directly to the executable.",
    ),
});

export function formatRunCommandResult(
  result: RunCommandResult,
): string {
  if (!result.ok) {
    return JSON.stringify({
      ok: false,
      workspace: result.workspace,
      executable: result.executable,
      args: result.args,
      code: result.code,
      message: result.message,
      ...(result.execution === undefined
        ? {}
        : {
            execution: {
              exitCode: result.execution.exitCode,
              signal: result.execution.signal,
              stdout: result.execution.stdout,
              stderr: result.execution.stderr,
              durationMs: result.execution.durationMs,
            },
          }),
    });
  }

  return JSON.stringify({
    ok: true,
    workspace: result.workspace,
    executable: result.executable,
    args: result.args,
    execution: {
      exitCode: result.execution.exitCode,
      stdout: result.execution.stdout,
      stderr: result.execution.stderr,
      durationMs: result.execution.durationMs,
    },
  });
}

export function desktopToolError(error: unknown) {
  if (error instanceof DesktopComputerUseError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            code: error.code,
            message: error.message,
          }),
        },
      ],
    };
  }

  throw error;
}

export function playwrightCliToolError(error: unknown) {
  if (error instanceof PlaywrightCliError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            code: error.code,
            message: error.message,
          }),
        },
      ],
    };
  }

  throw error;
}

export function jobToolError(error: unknown) {
  if (error instanceof JobManagerError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            code: error.code,
            message: error.message,
          }),
        },
      ],
    };
  }

  throw error;
}

export function fileToolError(error: unknown) {
  if (error instanceof WorkspaceFileError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            code: error.code,
            message: error.message,
          }),
        },
      ],
    };
  }

  throw error;
}
