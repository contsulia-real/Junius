import { realpath } from "node:fs/promises";
import {
  WorkspaceProfile,
  type WorkspaceCapabilityGrant,
} from "./workspace-profile.js";

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface WorkspaceState {
  readonly id: string;
  readonly rootPath: string;
  readonly grants: readonly WorkspaceCapabilityGrant[];
}

export class WorkspaceManager {
  readonly #profiles = new Map<string, WorkspaceProfile>();

  constructor(
    initialWorkspaces: readonly {
      readonly id: string;
      readonly profile: WorkspaceProfile;
    }[] = [],
  ) {
    for (const workspace of initialWorkspaces) {
      this.registerProfile(workspace.id, workspace.profile);
    }
  }

  get(id: string): WorkspaceProfile | undefined {
    return this.#profiles.get(id);
  }

  has(id: string): boolean {
    return this.#profiles.has(id);
  }

  list(): readonly WorkspaceState[] {
    return [...this.#profiles.entries()]
      .map(([id, profile]) => ({
        id,
        rootPath: profile.rootPath,
        grants: profile.grants(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async register(
    id: string,
    rootPath: string,
  ): Promise<WorkspaceProfile> {
    this.#assertValidId(id);

    const existing = this.#profiles.get(id);
    if (existing !== undefined) {
      throw new Error(`workspace_id_already_registered: ${id}`);
    }

    const canonicalRoot = await realpath(rootPath);

    for (const [existingId, profile] of this.#profiles) {
      if (samePath(profile.rootPath, canonicalRoot)) {
        throw new Error(
          `workspace_root_already_registered: ${existingId}`,
        );
      }
    }

    const profile = new WorkspaceProfile(canonicalRoot);
    this.#profiles.set(id, profile);
    return profile;
  }

  remove(id: string): boolean {
    return this.#profiles.delete(id);
  }

  private registerProfile(
    id: string,
    profile: WorkspaceProfile,
  ): void {
    this.#assertValidId(id);

    if (this.#profiles.has(id)) {
      throw new Error(`workspace_id_already_registered: ${id}`);
    }

    for (const [existingId, existing] of this.#profiles) {
      if (samePath(existing.rootPath, profile.rootPath)) {
        throw new Error(
          `workspace_root_already_registered: ${existingId}`,
        );
      }
    }

    this.#profiles.set(id, profile);
  }

  #assertValidId(id: string): void {
    if (!WORKSPACE_ID_PATTERN.test(id)) {
      throw new Error(`invalid_workspace_id: ${id}`);
    }
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
    : left === right;
}
