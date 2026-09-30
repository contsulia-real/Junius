import { join, resolve } from "node:path";
import type { JobHistoryRetention } from "./job-history-types.js";

const DEFAULT_MAX_AGE_MS =
  7 * 24 * 60 * 60 * 1_000;

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
  const maxEntries = positiveInteger(
    environment.JUNIUS_JOB_HISTORY_MAX_ENTRIES,
  );
  const maxAgeMs =
    positiveInteger(
      environment.JUNIUS_JOB_HISTORY_MAX_AGE_MS,
    ) ??
    DEFAULT_MAX_AGE_MS;

  return {
    ...(maxEntries === undefined
      ? {}
      : { maxEntries }),
    maxAgeMs,
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


