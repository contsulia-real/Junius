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
