import type { WorkspaceArgumentGrant } from "./workspace-profile.js";

export function parseArgumentGrants(value: unknown): WorkspaceArgumentGrant[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("arguments_must_be_nonempty_array");
  }

  return value.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("mode" in item) ||
      !("args" in item)
    ) {
      throw new Error("invalid_argument_grant");
    }

    const mode = item.mode;
    const args = item.args;

    if (mode !== "exact" && mode !== "prefix") {
      throw new Error("invalid_argument_grant_mode");
    }

    if (
      !Array.isArray(args) ||
      !args.every((arg): arg is string => typeof arg === "string")
    ) {
      throw new Error("invalid_argument_grant_args");
    }

    if (mode === "prefix" && args.length === 0) {
      throw new Error("empty_prefix_not_allowed");
    }

    return {
      mode,
      args,
    };
  });
}

export function parseWorkspaceRegistration(
  value: unknown,
): { id: string; rootPath: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    !("rootPath" in value) ||
    typeof value.id !== "string" ||
    typeof value.rootPath !== "string"
  ) {
    throw new Error("workspace_id_and_root_required");
  }

  return {
    id: value.id,
    rootPath: value.rootPath,
  };
}
