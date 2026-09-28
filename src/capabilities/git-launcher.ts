import {
  statSync,
} from "node:fs";
import {
  delimiter,
  join,
} from "node:path";

export interface GitLauncher {
  readonly executable: string;
  readonly fixedArgs: readonly string[];
}

export function isExistingGitFile(
  path: string,
): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function environmentPath(
  environment: NodeJS.ProcessEnv,
): string {
  return (
    environment.PATH ??
    environment.Path ??
    environment.path ??
    ""
  );
}

function candidatePaths(
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  const candidates: string[] = [];

  for (const rawEntry of environmentPath(environment).split(delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/u, "$1");
    if (!entry) continue;

    candidates.push(
      join(entry, "git.exe"),
      join(entry, "git"),
    );
  }

  return candidates;
}

export function resolveGitLauncher(
  environment: NodeJS.ProcessEnv = process.env,
): GitLauncher | undefined {
  for (const candidate of candidatePaths(environment)) {
    if (isExistingGitFile(candidate)) {
      return {
        executable: candidate,
        fixedArgs: [],
      };
    }
  }

  return undefined;
}
