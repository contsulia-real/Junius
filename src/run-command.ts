import type { AuditStore } from "./audit-store.js";
import {
  executePreparedProcess,
} from "./process-executor.js";
import type {
  PreparedProcess,
  ProcessExecution,
  ProcessExecutionErrorCode,
} from "./process-types.js";
import {
  WorkspaceManager,
  type WorkspaceState,
} from "./workspace-manager.js";

export const FOREGROUND_COMMAND_TIMEOUT_MS =
  15_000;
const DEFAULT_MAX_OUTPUT_BYTES =
  4 * 1024 * 1024;

export type CommandPreparation =
  | {
      readonly ok: true;
      readonly workspace: string;
      readonly executable: string;
      readonly args: readonly string[];
      readonly process: PreparedProcess;
    }
  | {
      readonly ok: false;
      readonly workspace: string;
      readonly executable: string;
      readonly args: readonly string[];
      readonly code:
        "workspace_not_registered";
      readonly message: string;
    };

export type RunCommandResult =
  | {
      readonly ok: true;
      readonly workspace: string;
      readonly executable: string;
      readonly args: readonly string[];
      readonly execution:
        Extract<
          ProcessExecution,
          { ok: true }
        >;
    }
  | {
      readonly ok: false;
      readonly workspace: string;
      readonly executable: string;
      readonly args: readonly string[];
      readonly code:
        | "workspace_not_registered"
        | ProcessExecutionErrorCode;
      readonly message: string;
      readonly execution?:
        Extract<
          ProcessExecution,
          { ok: false }
        >;
    };

export class RunCommandService {
  constructor(
    private readonly workspaceManager:
      WorkspaceManager,
    private readonly audit?:
      AuditStore,
    private readonly timeoutMs =
      FOREGROUND_COMMAND_TIMEOUT_MS,
    private readonly maxOutputBytes =
      DEFAULT_MAX_OUTPUT_BYTES,
  ) {}

  listWorkspaces():
    readonly WorkspaceState[] {
    return this.workspaceManager.list();
  }

  prepare(
    workspace: string,
    executable: string,
    args:
      readonly string[],
  ): CommandPreparation {
    const profile =
      this.workspaceManager
        .get(workspace);

    if (
      profile === undefined
    ) {
      return {
        ok: false,
        workspace,
        executable,
        args: [...args],
        code:
          "workspace_not_registered",
        message:
          `Workspace is not registered: ${workspace}`,
      };
    }

    return {
      ok: true,
      workspace,
      executable,
      args: [...args],
      process: {
        executable,
        args: [...args],
        cwd:
          profile.rootPath,
        env: {
          ...process.env,
        },
        windowsHide: true,
      },
    };
  }

  async run(
    workspace: string,
    executable: string,
    args:
      readonly string[],
  ): Promise<RunCommandResult> {
    const startedAt =
      performance.now();
    const prepared =
      this.prepare(
        workspace,
        executable,
        args,
      );

    if (!prepared.ok) {
      this.audit?.record({
        category: "command",
        action: "run_command",
        status: "failed",
        workspace,
        subject: executable,
        summary:
          prepared.code,
        durationMs:
          performance.now() -
          startedAt,
        metadata: {
          argCount:
            args.length,
          code:
            prepared.code,
        },
      });

      return prepared;
    }

    const execution =
      await executePreparedProcess(
        prepared.process,
        this.timeoutMs,
        this.maxOutputBytes,
      );

    this.audit?.record({
      category: "command",
      action: "run_command",
      status:
        execution.ok
          ? "succeeded"
          : "failed",
      workspace,
      subject: executable,
      summary:
        execution.ok
          ? "Command execution succeeded."
          : execution.code,
      durationMs:
        execution.durationMs,
      metadata: {
        argCount:
          args.length,
        exitCode:
          execution.exitCode ??
          -1,
        stdoutChars:
          execution.stdout.length,
        stderrChars:
          execution.stderr.length,
        ...(execution.ok
          ? {}
          : {
              code:
                execution.code,
            }),
      },
    });

    if (!execution.ok) {
      return {
        ok: false,
        workspace,
        executable,
        args: [...args],
        code:
          execution.code,
        message:
          execution.message,
        execution,
      };
    }

    return {
      ok: true,
      workspace,
      executable,
      args: [...args],
      execution,
    };
  }
}
