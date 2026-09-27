import { isAllowedPnpmArgs } from "./capabilities/pnpm-capability.js";
import { isAllowedGitArgs } from "./capabilities/git-capability.js";
import type { WorkspaceArgumentGrant } from "./workspace-profile.js";

export const KNOWN_KEYS = [
  "node",
  "pnpm",
  "git",
  "browser",
  "desktop",
] as const;

export type MachineCapabilityKey = (typeof KNOWN_KEYS)[number];
export type MachineCapabilityScope = "workspace" | "machine";

const NODE_ALLOWED_ARGUMENTS = [
  ["--version"],
  ["-p", "process.platform"],
] as const;

function startsWith(
  value: readonly string[],
  prefix: readonly string[],
): boolean {
  return (
    prefix.length <= value.length &&
    prefix.every((part, index) => value[index] === part)
  );
}

function nodeGrantCompatible(grant: WorkspaceArgumentGrant): boolean {
  if (grant.mode === "exact") {
    return NODE_ALLOWED_ARGUMENTS.some(
      (allowed) =>
        allowed.length === grant.args.length &&
        startsWith(allowed, grant.args),
    );
  }

  return (
    grant.args.length > 0 &&
    NODE_ALLOWED_ARGUMENTS.some((allowed) =>
      startsWith(allowed, grant.args),
    )
  );
}

function pnpmGrantCompatible(grant: WorkspaceArgumentGrant): boolean {
  if (grant.mode === "exact") {
    return isAllowedPnpmArgs(grant.args);
  }

  const args = grant.args;
  if (args.length === 0) return false;
  if (isAllowedPnpmArgs(args)) return true;

  if (args.length === 1 && (args[0] === "run" || args[0] === "add")) {
    return true;
  }

  if (args[0] !== "run") return false;
  if (args.length < 2) return false;

  const script = args[1] ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(script)) {
    return false;
  }

  if (args.length === 2) return true;
  return args[2] === "--";
}

function gitGrantCompatible(grant: WorkspaceArgumentGrant): boolean {
  if (grant.mode === "exact") {
    return isAllowedGitArgs(grant.args);
  }

  const args = grant.args;
  if (args.length === 0) return false;
  if (isAllowedGitArgs(args)) return true;

  const witnesses: readonly (readonly string[])[] = [
    ["--version"],
    ["init"],
    ["init", "-b", "main"],
    ["status"],
    ["status", "--short"],
    ["add", "-A"],
    ["add", "--", "README.md"],
    ["commit", "-m", "message"],
    ["commit", "--allow-empty", "-m", "message"],
    ["config", "--get", "user.name"],
    ["config", "--local", "user.name", "Junius"],
    ["branch"],
    ["branch", "--show-current"],
    ["branch", "-M", "main"],
    ["remote"],
    ["remote", "-v"],
    ["remote", "get-url", "origin"],
    ["remote", "add", "origin", "https://example.invalid/repo.git"],
    ["remote", "set-url", "origin", "https://example.invalid/repo.git"],
    ["remote", "remove", "origin"],
    ["fetch"],
    ["fetch", "origin"],
    ["push", "origin", "main"],
    ["push", "--force", "origin", "main"],
    ["push", "-u", "origin", "main"],
    ["push", "--force", "-u", "origin", "main"],
    ["rev-parse", "HEAD"],
    ["diff"],
    ["diff", "--cached"],
    ["log"],
    ["log", "-n", "1"],
    ["ls-files"],
  ];

  return witnesses.some((witness) => startsWith(witness, args));
}

export interface WorkspaceGrantCompatibility {
  readonly valid: boolean;
  readonly reason?:
    | "machine_capability_not_known"
    | "capability_not_workspace_scoped"
    | "arguments_outside_machine_policy";
}

export function workspaceGrantCompatibility(
  key: string,
  grant: WorkspaceArgumentGrant,
): WorkspaceGrantCompatibility {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      return {
        valid: false,
        reason: "machine_capability_not_known",
      };
    }

    if (key === "browser" || key === "desktop") {
      return {
        valid: false,
        reason: "capability_not_workspace_scoped",
      };
    }

    const valid =
      key === "node"
        ? nodeGrantCompatible(grant)
        : key === "pnpm"
          ? pnpmGrantCompatible(grant)
          : gitGrantCompatible(grant);

    return valid
      ? { valid: true }
      : {
          valid: false,
          reason: "arguments_outside_machine_policy",
        };

}
