import { statSync } from "node:fs";
import {
  delimiter,
  join,
} from "node:path";

function isFile(
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

export function resolveNodeExecutable(
  environment:
    NodeJS.ProcessEnv =
      process.env,
): string | undefined {
  for (
    const rawEntry of
    environmentPath(environment)
      .split(delimiter)
  ) {
    const entry =
      rawEntry
        .trim()
        .replace(
          /^"(.*)"$/u,
          "$1",
        );
    if (!entry) continue;

    const candidates =
      process.platform === "win32"
        ? [
            join(
              entry,
              "node.exe",
            ),
            join(
              entry,
              "node",
            ),
          ]
        : [
            join(
              entry,
              "node",
            ),
          ];

    for (
      const candidate of
      candidates
    ) {
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}
