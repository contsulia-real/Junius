import { readdir } from "node:fs/promises";
import {
  delimiter,
  isAbsolute,
  join,
} from "node:path";

export interface ExecutableCandidate {
  readonly name: string;
  readonly path: string;
  readonly source: "path";
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const target = name.toUpperCase();
  for (const [key, value] of Object.entries(
    environment,
  )) {
    if (key.toUpperCase() === target) {
      return value;
    }
  }
  return undefined;
}

function candidateRank(
  name: string,
  query: string,
): number {
  if (!query) return 3;
  const lower = name.toLowerCase();
  if (lower === query) return 0;
  if (lower.startsWith(query)) return 1;
  return 2;
}

export async function discoverPathExecutables(
  environment: NodeJS.ProcessEnv = process.env,
  query = "",
  limit = 50,
  platform: NodeJS.Platform = process.platform,
): Promise<readonly ExecutableCandidate[]> {
  const normalizedQuery =
    query.trim().toLowerCase();
  const boundedLimit = Math.max(
    1,
    Math.min(100, Math.trunc(limit) || 50),
  );
  const pathValue =
    environmentValue(environment, "PATH") ?? "";

  const directories = [
    ...new Set(
      pathValue
        .split(delimiter)
        .map((value) => value.trim())
        .filter(
          (value) =>
            value.length > 0 &&
            isAbsolute(value),
        ),
    ),
  ];

  const seen = new Set<string>();
  const candidates:
    ExecutableCandidate[] = [];

  for (const directory of directories) {
    let entries;
    try {
      entries = await readdir(directory, {
        withFileTypes: true,
      });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      if (
        platform === "win32" &&
        !/\.(?:exe|com|cmd|bat)$/iu.test(
          entry.name,
        )
      ) {
        continue;
      }

      const lowerName =
        entry.name.toLowerCase();
      if (
        normalizedQuery &&
        !lowerName.includes(
          normalizedQuery,
        )
      ) {
        continue;
      }

      const path = join(
        directory,
        entry.name,
      );
      const identity =
        platform === "win32"
          ? path.toLowerCase()
          : path;
      if (seen.has(identity)) continue;
      seen.add(identity);

      candidates.push({
        name: entry.name,
        path,
        source: "path",
      });
    }
  }

  candidates.sort((left, right) => {
    const rank =
      candidateRank(
        left.name,
        normalizedQuery,
      ) -
      candidateRank(
        right.name,
        normalizedQuery,
      );
    return (
      rank ||
      left.name.localeCompare(
        right.name,
      ) ||
      left.path.localeCompare(
        right.path,
      )
    );
  });

  return candidates.slice(
    0,
    boundedLimit,
  );
}
