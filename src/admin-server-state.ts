import type { MachineCapabilityManager } from "./machine-capabilities.js";
import type { WorkspaceManager } from "./workspace-manager.js";

export function workspaceAdminState(
  workspaces: WorkspaceManager,
  machineCapabilities: MachineCapabilityManager,
) {
  return workspaces.list().map((workspace) => ({
    ...workspace,
    grants: workspace.grants.map((grant) => ({
      ...grant,
      arguments: grant.arguments.map((rule) => ({
        ...rule,
        ...machineCapabilities.workspaceGrantCompatibility(
          grant.key,
          rule,
        ),
      })),
    })),
  }));
}
