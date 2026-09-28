import type { PersistedJobMetadata } from "./job-history-types.js";

export function validJobHistoryId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    id,
  );
}

export function parseJobHistoryMetadata(
  value: unknown,
): PersistedJobMetadata | undefined {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return undefined;
  }

  const record = value as Partial<PersistedJobMetadata>;

  if (
    record.version !== 1 ||
    typeof record.id !== "string" ||
    !validJobHistoryId(record.id) ||
    typeof record.workspace !== "string" ||
    typeof record.key !== "string" ||
    ![
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(
      String(record.status),
    ) ||
    !(
      record.pid === null ||
      typeof record.pid === "number"
    ) ||
    typeof record.startedAt !== "string" ||
    typeof record.endedAt !== "string" ||
    typeof record.stdoutChars !== "number" ||
    !Number.isSafeInteger(record.stdoutChars) ||
    record.stdoutChars < 0 ||
    typeof record.stderrChars !== "number" ||
    !Number.isSafeInteger(record.stderrChars) ||
    record.stderrChars < 0 ||
    typeof record.stdoutTruncated !== "boolean" ||
    typeof record.stderrTruncated !== "boolean"
  ) {
    return undefined;
  }

  for (const bytes of [
    record.stdoutBytes,
    record.stderrBytes,
  ]) {
    if (
      bytes !== undefined &&
      (
        typeof bytes !== "number" ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0
      )
    ) {
      return undefined;
    }
  }

  if (
    record.exitCode !== undefined &&
    record.exitCode !== null &&
    typeof record.exitCode !== "number"
  ) {
    return undefined;
  }

  if (
    record.signal !== undefined &&
    record.signal !== null &&
    typeof record.signal !== "string"
  ) {
    return undefined;
  }

  if (
    record.message !== undefined &&
    typeof record.message !== "string"
  ) {
    return undefined;
  }

  return record as PersistedJobMetadata;
}


