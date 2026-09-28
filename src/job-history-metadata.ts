import type {
  PersistedJobMetadata,
  PersistedJobStatus,
} from "./job-history-types.js";

export function validJobHistoryId(
  id: string,
): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    id,
  );
}

function validStatus(
  value: unknown,
): value is PersistedJobStatus {
  return [
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ].includes(String(value));
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

  const record =
    value as Record<
      string,
      unknown
    >;
  const version =
    record.version;
  const executable =
    version === 2
      ? record.executable
      : version === 1
        ? record.key
        : undefined;

  if (
    (version !== 1 &&
      version !== 2) ||
    typeof record.id !==
      "string" ||
    !validJobHistoryId(
      record.id,
    ) ||
    typeof record.workspace !==
      "string" ||
    typeof executable !==
      "string" ||
    !validStatus(
      record.status,
    ) ||
    !(
      record.pid === null ||
      typeof record.pid ===
        "number"
    ) ||
    typeof record.startedAt !==
      "string" ||
    typeof record.endedAt !==
      "string" ||
    typeof record.stdoutChars !==
      "number" ||
    !Number.isSafeInteger(
      record.stdoutChars,
    ) ||
    record.stdoutChars < 0 ||
    typeof record.stderrChars !==
      "number" ||
    !Number.isSafeInteger(
      record.stderrChars,
    ) ||
    record.stderrChars < 0 ||
    typeof record.stdoutTruncated !==
      "boolean" ||
    typeof record.stderrTruncated !==
      "boolean"
  ) {
    return undefined;
  }

  for (
    const bytes of [
      record.stdoutBytes,
      record.stderrBytes,
    ]
  ) {
    if (
      bytes !== undefined &&
      (
        typeof bytes !==
          "number" ||
        !Number.isSafeInteger(
          bytes,
        ) ||
        bytes < 0
      )
    ) {
      return undefined;
    }
  }

  if (
    record.exitCode !==
      undefined &&
    record.exitCode !== null &&
    typeof record.exitCode !==
      "number"
  ) {
    return undefined;
  }

  if (
    record.signal !==
      undefined &&
    record.signal !== null &&
    typeof record.signal !==
      "string"
  ) {
    return undefined;
  }

  if (
    record.message !==
      undefined &&
    typeof record.message !==
      "string"
  ) {
    return undefined;
  }

  return {
    version: 2,
    id: record.id,
    workspace:
      record.workspace,
    executable,
    status: record.status,
    pid:
      record.pid as
        number | null,
    startedAt:
      record.startedAt,
    endedAt:
      record.endedAt,
    ...(record.exitCode ===
    undefined
      ? {}
      : {
          exitCode:
            record.exitCode as
              number | null,
        }),
    ...(record.signal ===
    undefined
      ? {}
      : {
          signal:
            record.signal as
              NodeJS.Signals |
              null,
        }),
    ...(record.message ===
    undefined
      ? {}
      : {
          message:
            record.message,
        }),
    stdoutChars:
      record.stdoutChars,
    stderrChars:
      record.stderrChars,
    ...(record.stdoutBytes ===
    undefined
      ? {}
      : {
          stdoutBytes:
            record.stdoutBytes as
              number,
        }),
    ...(record.stderrBytes ===
    undefined
      ? {}
      : {
          stderrBytes:
            record.stderrBytes as
              number,
        }),
    stdoutTruncated:
      record.stdoutTruncated,
    stderrTruncated:
      record.stderrTruncated,
  };
}
