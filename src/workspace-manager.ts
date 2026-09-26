import { realpath } from "node:fs/promises";
import {
  WorkspaceProfile,
  type WorkspaceCapabilityGrant,
} from "./workspace-profile.js";

function workspaceKey(rootPath: string): string {
  return process.platform === "win32"
    ? rootPath.toLowerCase()
    : rootPath;
}

export interface WorkspaceState {
  readonly rootPath: string;
  readonly grants: readonly WorkspaceCapabilityGrant[];
  readonly active: boolean;
}

export class WorkspaceManager {
  readonly #profiles = new Map<string, WorkspaceProfile>();
  #activeKey: string;

  constructor(initialProfile: WorkspaceProfile) {
    const key = workspaceKey(initialProfile.rootPath);
    this.#profiles.set(key, initialProfile);
    this.#activeKey = key;
  }

  activeProfile(): WorkspaceProfile {
    const profile = this.#profiles.get(this.#activeKey);
    if (profile === undefined) {
      throw new Error("active_workspace_missing");
    }

    return profile;
  }

  list(): readonly WorkspaceState[] {
    return [...this.#profiles.entries()]
      .map(([key, profile]) => ({
        rootPath: profile.rootPath,
        grants: profile.grants(),
        active: key === this.#activeKey,
      }))
      .sort((left, right) => left.rootPath.localeCompare(right.rootPath));
  }

  async register(rootPath: string): Promise<WorkspaceProfile> {
    const canonicalRoot = await realpath(rootPath);
    const key = workspaceKey(canonicalRoot);
    const existing = this.#profiles.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const profile = new WorkspaceProfile(canonicalRoot);
    this.#profiles.set(key, profile);
    return profile;
  }

  async activate(rootPath: string): Promise<WorkspaceProfile | undefined> {
    const canonicalRoot = await realpath(rootPath);
    const key = workspaceKey(canonicalRoot);
    const profile = this.#profiles.get(key);

    if (profile === undefined) {
      return undefined;
    }

    this.#activeKey = key;
    return profile;
  }
}
