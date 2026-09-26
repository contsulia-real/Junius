import type {
  Capability,
  CapabilityExecution,
  CapabilityExecutionContext,
} from "./capabilities/types.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import {
  WorkspaceManager,
  type WorkspaceState,
} from "./workspace-manager.js";

export type InvocationAuthorizationErrorCode =
  | "workspace_not_registered"
  | "capability_not_registered"
  | "capability_not_allowed"
  | "arguments_not_allowed_by_workspace";

export type AuthorizedInvocation =
  | {
      readonly ok: true;
      readonly workspace: string;
      readonly key: string;
      readonly capability: Capability;
      readonly context: CapabilityExecutionContext;
    }
  | {
      readonly ok: false;
      readonly workspace: string;
      readonly key: string;
      readonly code: InvocationAuthorizationErrorCode;
      readonly message: string;
    };

export function authorizeInvocation(
  registry: CapabilityRegistry,
  workspaceManager: WorkspaceManager,
  workspace: string,
  key: string,
  args: readonly string[],
): AuthorizedInvocation {
  const profile = workspaceManager.get(workspace);

  if (profile === undefined) {
    return {
      ok: false,
      workspace,
      key,
      code: "workspace_not_registered",
      message: `Workspace is not registered: ${workspace}`,
    };
  }

  const capability = registry.get(key);

  if (capability === undefined) {
    return {
      ok: false,
      workspace,
      key,
      code: "capability_not_registered",
      message: `Capability is not registered: ${key}`,
    };
  }

  if (!profile.hasCapabilityGrant(key)) {
    return {
      ok: false,
      workspace,
      key,
      code: "capability_not_allowed",
      message: `Capability is not allowed by Workspace ${workspace}: ${key}`,
    };
  }

  if (!profile.isInvocationAllowed(key, args)) {
    return {
      ok: false,
      workspace,
      key,
      code: "arguments_not_allowed_by_workspace",
      message: `Arguments are not allowed for capability ${key} by Workspace ${workspace}.`,
    };
  }

  return {
    ok: true,
    workspace,
    key,
    capability,
    context: {
      cwd: profile.rootPath,
    },
  };
}

export type RunCommandResult =
  | {
      readonly ok: true;
      readonly workspace: string;
      readonly key: string;
      readonly execution: Extract<CapabilityExecution, { ok: true }>;
    }
  | {
      readonly ok: false;
      readonly workspace: string;
      readonly key: string;
      readonly code:
        | InvocationAuthorizationErrorCode
        | Extract<CapabilityExecution, { ok: false }>["code"];
      readonly message: string;
      readonly execution?: Extract<CapabilityExecution, { ok: false }>;
    };

export class RunCommandService {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly workspaceManager: WorkspaceManager,
  ) {}

  listWorkspaces(): readonly WorkspaceState[] {
    return this.workspaceManager.list();
  }

  authorize(
    workspace: string,
    key: string,
    args: readonly string[],
  ): AuthorizedInvocation {
    return authorizeInvocation(
      this.registry,
      this.workspaceManager,
      workspace,
      key,
      args,
    );
  }

  async run(
    workspace: string,
    key: string,
    args: readonly string[],
  ): Promise<RunCommandResult> {
    const authorized = this.authorize(workspace, key, args);

    if (!authorized.ok) {
      return authorized;
    }

    const execution = await authorized.capability.execute(
      args,
      authorized.context,
    );

    if (!execution.ok) {
      return {
        ok: false,
        workspace,
        key,
        code: execution.code,
        message: execution.message,
        execution,
      };
    }

    return {
      ok: true,
      workspace,
      key,
      execution,
    };
  }
}
