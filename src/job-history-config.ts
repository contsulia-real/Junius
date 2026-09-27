import { join, resolve } from "node:path";
import type { JobHistoryRetention } from "./job-history-types.js";

function positiveInteger(
  value: string | undefined,
): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0
  ) {
    return undefined;
  }

  return parsed;
}

export function resolveJobHistoryRetention(
  environment: NodeJS.ProcessEnv = process.env,
): JobHistoryRetention {
  return {
    ...(positiveInteger(
      environment.JUNIUS_JOB_HISTORY_MAX_ENTRIES,
    ) === undefined
      ? {}
      : {
          maxEntries: positiveInteger(
            environment.JUNIUS_JOB_HISTORY_MAX_ENTRIES,
          ),
        }),
    ...(positiveInteger(
      environment.JUNIUS_JOB_HISTORY_MAX_AGE_MS,
    ) === undefined
      ? {}
      : {
          maxAgeMs: positiveInteger(
            environment.JUNIUS_JOB_HISTORY_MAX_AGE_MS,
          ),
        }),
  };
}

export function resolveJuniusRuntimeRoot(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const projectRoot =
    environment.JUNIUS_PROJECT_ROOT ?? cwd;

  return resolve(
    environment.JUNIUS_RUNTIME_ROOT ??
      join(projectRoot, ".junius", "runtime"),
  );
}

export function resolveJobHistoryPath(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  return join(
    resolveJuniusRuntimeRoot(
      environment,
      cwd,
    ),
    "jobs",
  );
}


