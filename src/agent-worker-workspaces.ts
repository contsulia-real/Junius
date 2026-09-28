import type { RuntimeConfig } from "./config.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceProfile } from "./workspace-profile.js";
import { WorkspaceStateStore } from "./workspace-state-store.js";

export interface AgentWorkerWorkspaceRuntime {
  readonly workspaces:
    WorkspaceManager;
  readonly stateStore:
    WorkspaceStateStore;
  reloadConfiguration():
    Promise<void>;
}

export async function createAgentWorkerWorkspaceRuntime(
  config: RuntimeConfig,
): Promise<AgentWorkerWorkspaceRuntime> {
  const stateStore =
    new WorkspaceStateStore(
      config.workspaceStatePath,
    );
  const persistedWorkspaces =
    await stateStore.load();

  let workspaces:
    WorkspaceManager;

  if (
    persistedWorkspaces ===
    undefined
  ) {
    workspaces =
      new WorkspaceManager([
        {
          id:
            config.workspaceId,
          profile:
            new WorkspaceProfile(
              config.workspaceRoot,
            ),
        },
      ]);

    await stateStore
      .save(workspaces);
  } else {
    workspaces =
      new WorkspaceManager(
        persistedWorkspaces.map(
          (workspace) => ({
            id:
              workspace.id,
            profile:
              new WorkspaceProfile(
                workspace.rootPath,
              ),
          }),
        ),
      );
  }

  let reloadQueue:
    Promise<void> =
      Promise.resolve();

  const reloadConfiguration =
    (): Promise<void> => {
      const operation =
        reloadQueue.then(
          async () => {
            const persisted =
              await stateStore
                .load();
            if (
              persisted ===
              undefined
            ) {
              throw new Error(
                "workspace_state_missing",
              );
            }

            workspaces.replace(
              persisted,
            );
          },
        );

      reloadQueue =
        operation.catch(
          () => undefined,
        );
      return operation;
    };

  return {
    workspaces,
    stateStore,
    reloadConfiguration,
  };
}
