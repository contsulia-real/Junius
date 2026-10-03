import {
  AsyncLocalStorage,
} from "node:async_hooks";

interface McpSessionContext {
  readonly sessionId?: string;
}

const storage =
  new AsyncLocalStorage<
    McpSessionContext
  >();

export function withMcpSessionContext<T>(
  sessionId: string | undefined,
  operation: () => T,
): T {
  return storage.run(
    {
      ...(sessionId === undefined
        ? {}
        : { sessionId }),
    },
    operation,
  );
}

export function currentMcpSessionId():
  string | undefined {
  return storage.getStore()
    ?.sessionId;
}

function metadataRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {};
  }

  return value as Readonly<
    Record<string, unknown>
  >;
}

function sessionString(
  value: unknown,
): string | undefined {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512
  )
    ? value
    : undefined;
}

export function observabilitySessionId(
  metadata?: unknown,
): string | undefined {
  const transportSessionId =
    currentMcpSessionId();

  if (
    transportSessionId !==
    undefined
  ) {
    return transportSessionId;
  }

  const openAiSession =
    sessionString(
      metadataRecord(
        metadata,
      )["openai/session"],
    );

  return openAiSession ===
    undefined
    ? undefined
    : `openai:${openAiSession}`;
}
