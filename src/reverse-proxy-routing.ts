import type { IncomingMessage } from "node:http";
import type { WorkerSupervisor } from "./worker-supervisor.js";

export interface McpToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export function parseToolCall(body: Buffer): McpToolCall | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return undefined;
  }

  const message = parsed as {
    method?: unknown;
    params?: unknown;
  };

  if (
    message.method !== "tools/call" ||
    typeof message.params !== "object" ||
    message.params === null
  ) {
    return undefined;
  }

  const params = message.params as {
    name?: unknown;
    arguments?: unknown;
  };

  if (typeof params.name !== "string") {
    return undefined;
  }

  return {
    name: params.name,
    arguments:
      typeof params.arguments === "object" &&
      params.arguments !== null &&
      !Array.isArray(params.arguments)
        ? params.arguments as Record<string, unknown>
        : {},
  };
}

function argumentString(
  call: McpToolCall,
  key: string,
  fallback?: string,
): string | undefined {
  const value = call.arguments[key];
  return typeof value === "string" ? value : fallback;
}

export function isConfigurationMutationRequest(
  req: IncomingMessage,
): boolean {
  const method = req.method ?? "";
  if (method !== "POST" && method !== "DELETE") {
    return false;
  }

  const pathname = new URL(
    req.url ?? "/",
    "http://127.0.0.1",
  ).pathname;
  const rawSegments = pathname
    .split("/")
    .filter((segment) => segment.length > 0);
  const segments =
    rawSegments[0] === "api"
      ? rawSegments.slice(1)
      : rawSegments;

  if (
    segments[0] === "capabilities" &&
    (
      (method === "POST" &&
        (segments.length === 1 ||
          segments.length === 2)) ||
      (method === "DELETE" &&
        segments.length === 2)
    )
  ) {
    return true;
  }

  if (
    method === "POST" &&
    segments.length === 1 &&
    segments[0] === "workspaces"
  ) {
    return true;
  }

  if (
    method === "DELETE" &&
    segments.length === 2 &&
    segments[0] === "workspaces"
  ) {
    return true;
  }

  return (
    (method === "POST" || method === "DELETE") &&
    segments.length === 4 &&
    segments[0] === "workspaces" &&
    segments[2] === "grants"
  );
}

export function routeKeyForTool(
  call: McpToolCall | undefined,
): string | undefined {
  if (call === undefined) return undefined;

  if (
    ["get_job", "wait_job", "read_job_output", "cancel_job"].includes(
      call.name,
    )
  ) {
    const job = argumentString(call, "job");
    return job === undefined ? undefined : `job:${job}`;
  }

  if (call.name === "playwright_cli") {
    const session = argumentString(call, "session", "junius")!;
    return `browser:${session}`;
  }

  if (call.name === "desktop") {
    const session = argumentString(call, "session", "junius")!;
    return `desktop:${session}`;
  }

  return undefined;
}

export function bindBeforeForward(
  supervisor: WorkerSupervisor,
  call: McpToolCall | undefined,
  workerId: string,
): void {
  if (call === undefined) return;

  if (call.name === "playwright_cli") {
    const command = argumentString(call, "command");
    if (command !== "close") {
      const session = argumentString(call, "session", "junius")!;
      supervisor.bindResource(
        `browser:${session}`,
        workerId,
      );
    }
    return;
  }
}

export function releaseAfterForward(
  supervisor: WorkerSupervisor,
  call: McpToolCall | undefined,
): void {
  if (
    call?.name === "playwright_cli" &&
    argumentString(call, "command") === "close"
  ) {
    const session = argumentString(call, "session", "junius")!;
    supervisor.releaseResource(`browser:${session}`);
  }
}

export function toolCallSucceeded(
  responseBody: string,
): boolean {
  for (const message of jsonRpcMessages(responseBody)) {
    if (
      typeof message !== "object" ||
      message === null ||
      !("result" in message)
    ) {
      continue;
    }

    const result = (
      message as {
        result?: unknown;
      }
    ).result;

    if (
      typeof result !== "object" ||
      result === null
    ) {
      return false;
    }

    return (
      !("isError" in result) ||
      (result as { isError?: unknown }).isError !== true
    );
  }

  return false;
}

function jsonRpcMessages(
  body: string,
): readonly unknown[] {
  const messages: unknown[] = [];

  try {
    messages.push(JSON.parse(body) as unknown);
  } catch {
    for (const line of body.split(/\r?\n/u)) {
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        messages.push(JSON.parse(payload) as unknown);
      } catch {
        // Ignore malformed/non-JSON SSE events.
      }
    }
  }

  return messages;
}

export function extractStartedJobId(
  responseBody: string,
): string | undefined {
  for (const message of jsonRpcMessages(responseBody)) {
    if (
      typeof message !== "object" ||
      message === null ||
      !("result" in message)
    ) {
      continue;
    }

    const result = (
      message as {
        result?: {
          content?: unknown;
        };
      }
    ).result;

    if (!Array.isArray(result?.content)) {
      continue;
    }

    for (const item of result.content) {
      if (
        typeof item !== "object" ||
        item === null ||
        (item as { type?: unknown }).type !== "text" ||
        typeof (item as { text?: unknown }).text !== "string"
      ) {
        continue;
      }

      try {
        const payload = JSON.parse(
          (item as { text: string }).text,
        ) as {
          ok?: unknown;
          job?: {
            id?: unknown;
          };
        };

        if (
          payload.ok === true &&
          typeof payload.job?.id === "string"
        ) {
          return payload.job.id;
        }
      } catch {
        // This text content is not the start_job JSON payload.
      }
    }
  }

  return undefined;
}


