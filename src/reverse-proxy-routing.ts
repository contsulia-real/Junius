import type { WorkerSupervisor } from "./worker-supervisor.js";
import { createHash } from "node:crypto";

export interface McpToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly chatId?: string;
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
    _meta?: unknown;
  };

  if (typeof params.name !== "string") {
    return undefined;
  }

  const metadata = params._meta;
  const chat = metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)["openai/session"]
    : undefined;

  return {
    name: params.name,
    ...(typeof chat === "string" && chat.length > 0 && chat.length <= 512
      ? { chatId: "openai:" + chat } : {}),
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

function scopedDeviceKey(kind: "browser" | "desktop", name: string, chat?: string): string {
  const scope = chat === undefined ? "" : createHash("sha256").update(chat).digest("hex").slice(0, 16) + ":";
  return `${kind}:${scope}${name}`;
}

export function routeKeyForTool(
  call: McpToolCall | undefined,
  chat?: string,
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
    return scopedDeviceKey("browser", session, chat);
  }

  if (call.name === "desktop") {
    const session = argumentString(call, "session", "junius")!;
    return scopedDeviceKey("desktop", session, chat);
  }

  return undefined;
}

export function bindBeforeForward(
  supervisor: WorkerSupervisor,
  call: McpToolCall | undefined,
  workerId: string,
  chat?: string,
): void {
  if (call === undefined) return;

  if (call.name === "playwright_cli") {
    const command = argumentString(call, "command");
    if (command !== "close") {
      const session = argumentString(call, "session", "junius")!;
      supervisor.bindResource(
        scopedDeviceKey("browser", session, chat),
        workerId,
      );
    }
    return;
  }
}

export function releaseAfterForward(
  supervisor: WorkerSupervisor,
  call: McpToolCall | undefined,
  chat?: string,
): void {
  if (
    call?.name === "playwright_cli" &&
    argumentString(call, "command") === "close"
  ) {
    const session = argumentString(call, "session", "junius")!;
    supervisor.releaseResource(scopedDeviceKey("browser", session, chat));
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


