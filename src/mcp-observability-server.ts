import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  RegisteredTool,
  ServerContext,
} from "@modelcontextprotocol/server";
import type {
  McpObservabilityStore,
  ObservedToolDescriptor,
} from "./mcp-observability.js";
import {
  currentMcpSessionId,
} from "./mcp-session-context.js";
import {
  JUNIUS_TURN_BEGIN_TOOL,
  JUNIUS_TURN_END_TOOL,
} from "./mcp-turn-tools.js";

export const JUNIUS_TEST_WINDOW_CLOSE_TOOL =
  "close_junius_test_window";
export const JUNIUS_PANEL_TOOL =
  "junius_observability_panel";
export const JUNIUS_PANEL_SNAPSHOT_TOOL =
  "junius_observability_snapshot";

const INTERNAL_OBSERVABILITY_TOOLS =
  new Set([
    JUNIUS_PANEL_TOOL,
    JUNIUS_PANEL_SNAPSHOT_TOOL,
    JUNIUS_TURN_BEGIN_TOOL,
    JUNIUS_TURN_END_TOOL,
  ]);

interface McpServerRegistryView {
  readonly _registeredTools?:
    Record<string, RegisteredTool>;
  executeToolHandler(
    tool: RegisteredTool,
    args: unknown,
    context: ServerContext,
  ): Promise<
    CallToolResult |
    InputRequiredResult
  >;
}

function registeredTools(
  server: McpServer,
): Readonly<
  Record<string, RegisteredTool>
> {
  return (
    server as unknown as
      McpServerRegistryView
  )._registeredTools ?? {};
}

function appOnly(
  tool: RegisteredTool,
): boolean {
  const ui =
    tool._meta?.ui;
  if (
    ui === null ||
    typeof ui !== "object" ||
    Array.isArray(ui)
  ) {
    return false;
  }

  const visibility =
    (
      ui as {
        visibility?: unknown;
      }
    ).visibility;

  return (
    Array.isArray(visibility) &&
    visibility.includes("app") &&
    !visibility.includes("model")
  );
}

const TURN_END_REMINDER =
  "[Junius internal] If this is the final Junius tool call for the current user message, call junius_turn_end before writing the final assistant answer.";

function withTurnEndReminder(
  result:
    | CallToolResult
    | InputRequiredResult,
):
  | CallToolResult
  | InputRequiredResult {
  const content =
    (
      result as {
        content?: unknown;
      }
    ).content;

  if (!Array.isArray(content)) {
    return result;
  }

  return {
    ...result,
    content: [
      ...content,
      {
        type:
          "text" as const,
        text:
          TURN_END_REMINDER,
      },
    ],
  } as
    | CallToolResult
    | InputRequiredResult;
}

function catalog(
  server: McpServer,
): readonly ObservedToolDescriptor[] {
  return Object.entries(
    registeredTools(server),
  )
    .filter(
      ([name, tool]) =>
        !INTERNAL_OBSERVABILITY_TOOLS
          .has(name) &&
        tool.enabled !==
          false &&
        !appOnly(tool),
    )
    .map(
      ([name, tool]) => ({
        name,
        ...(tool.title === undefined
          ? {}
          : {
              title:
                tool.title,
            }),
      }),
    );
}

function toolName(
  server: McpServer,
  tool: RegisteredTool,
): string | undefined {
  for (
    const [
      name,
      registered,
    ] of Object.entries(
      registeredTools(server),
    )
  ) {
    if (registered === tool) {
      return name;
    }
  }

  return undefined;
}

export function attachMcpObservability(
  server: McpServer,
  observability:
    McpObservabilityStore,
): void {
  observability.replaceToolCatalog(
    catalog(server),
  );

  const serverView =
    server as unknown as
      McpServerRegistryView;
  const execute =
    serverView
      .executeToolHandler
      .bind(server);

  serverView.executeToolHandler =
    async (
      tool,
      args,
      context,
    ) => {
      const name =
        toolName(
          server,
          tool,
        );

      if (
        name === undefined ||
        INTERNAL_OBSERVABILITY_TOOLS
          .has(name)
      ) {
        return execute(
          tool,
          args,
          context,
        );
      }

      const sessionId =
        currentMcpSessionId();

      if (sessionId === undefined) {
        return {
          isError: true,
          content: [
            {
              type:
                "text" as const,
              text:
                "Junius MCP session is unavailable for observability.",
            },
          ],
        };
      }

      if (
        !observability.hasActiveTurn(
          sessionId,
        )
      ) {
        return {
          isError: true,
          content: [
            {
              type:
                "text" as const,
              text:
                "Junius turn is not started. Call junius_turn_begin with the current user input parts, then retry " +
                name +
                ".",
            },
          ],
        };
      }

      const callId =
        observability.beginToolCall(
          name,
          args,
          sessionId,
        );

      try {
        const result =
          await execute(
            tool,
            args,
            context,
          );
        const isError =
          (
            result as {
              isError?: unknown;
            }
          ).isError === true;

        observability.finishToolCall(
          callId,
          isError
            ? "failed"
            : "succeeded",
          result,
        );
        return withTurnEndReminder(
          result,
        );
      } catch (error) {
        observability.finishToolCall(
          callId,
          "failed",
        );
        throw error;
      }
    };
}
