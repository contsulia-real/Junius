import type { CapabilityExecution } from "./capabilities/types.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { WorkspaceProfile } from "./workspace-profile.js";

export type RunCommandResult =
  | {
      readonly ok: true;
      readonly key: string;
      readonly execution: Extract<CapabilityExecution, { ok: true }>;
    }
  | {
      readonly ok: false;
      readonly key: string;
      readonly code:
        | "capability_not_registered"
        | "capability_not_allowed"
        | Extract<CapabilityExecution, { ok: false }>["code"];
      readonly message: string;
      readonly execution?: Extract<CapabilityExecution, { ok: false }>;
    };

export class RunCommandService {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly workspaceProfile: WorkspaceProfile,
  ) {}

  async run(
    key: string,
    args: readonly string[],
  ): Promise<RunCommandResult> {
    const capability = this.registry.get(key);

    if (capability === undefined) {
      return {
        ok: false,
        key,
        code: "capability_not_registered",
        message: `Capability is not registered: ${key}`,
      };
    }

    if (!this.workspaceProfile.isAllowed(key)) {
      return {
        ok: false,
        key,
        code: "capability_not_allowed",
        message: `Capability is not allowed by the current Workspace Profile: ${key}`,
      };
    }

    const execution = await capability.execute(args, {
      cwd: this.workspaceProfile.rootPath,
    });

    if (!execution.ok) {
      return {
        ok: false,
        key,
        code: execution.code,
        message: execution.message,
        execution,
      };
    }

    return {
      ok: true,
      key,
      execution,
    };
  }
}
