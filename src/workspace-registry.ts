import type { AuditStore } from "./audit-store.js";
import {
  WorkspaceManager,
  type WorkspaceState,
} from "./workspace-manager.js";
import { WorkspaceStateStore } from "./workspace-state-store.js";

export type WorkspaceRegistryErrorCode =
  | "workspace_not_registered"
  | "workspace_create_failed";

export class WorkspaceRegistryError
  extends Error {
  constructor(
    readonly code:
      WorkspaceRegistryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class WorkspaceRegistryService {
  constructor(
    private readonly workspaces:
      WorkspaceManager,
    private readonly stateStore:
      WorkspaceStateStore,
    private readonly audit?:
      AuditStore,
  ) {}

  list():
    readonly WorkspaceState[] {
    return this.workspaces.list();
  }

  async create(
    id: string,
    rootPath: string,
  ): Promise<WorkspaceState> {
    try {
      const workspace =
        await this.workspaces
          .register(
            id,
            rootPath,
          );

      try {
        await this.stateStore
          .save(this.workspaces);
      } catch (error) {
        this.workspaces
          .remove(id);
        throw error;
      }

      this.audit?.record({
        category:
          "configuration",
        action:
          "workspace_create",
        status:
          "succeeded",
        workspace: id,
        subject:
          workspace.rootPath,
        summary:
          "Workspace registered.",
      });

      return workspace;
    } catch (error) {
      this.audit?.record({
        category:
          "configuration",
        action:
          "workspace_create",
        status: "failed",
        workspace: id,
        subject: rootPath,
        summary:
          error instanceof Error
            ? error.message
            : String(error),
      });

      throw new WorkspaceRegistryError(
        "workspace_create_failed",
        error instanceof Error
          ? error.message
          : String(error),
      );
    }
  }

  async delete(
    id: string,
  ): Promise<WorkspaceState> {
    const removed =
      this.workspaces
        .remove(id);

    if (removed === undefined) {
      throw new WorkspaceRegistryError(
        "workspace_not_registered",
        `Workspace is not registered: ${id}`,
      );
    }

    try {
      await this.stateStore
        .save(this.workspaces);
    } catch (error) {
      await this.workspaces
        .register(
          removed.id,
          removed.rootPath,
        );
      throw error;
    }

    this.audit?.record({
      category:
        "configuration",
      action:
        "workspace_delete",
      status:
        "succeeded",
      workspace: id,
      subject:
        removed.rootPath,
      summary:
        "Workspace unregistered.",
    });

    return removed;
  }
}
