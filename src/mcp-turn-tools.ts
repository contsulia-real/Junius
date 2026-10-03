import type {
  McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  extractOpenAiRequestIdentity,
  type McpObservabilityStore,
} from "./mcp-observability.js";

export const JUNIUS_TURN_BEGIN_TOOL =
  "junius_turn_begin";
export const JUNIUS_TURN_END_TOOL =
  "junius_turn_end";

const promptPartSchema =
  z.discriminatedUnion(
    "type",
    [
      z.object({
        type:
          z.literal("text"),
        text:
          z.string(),
      }),
      z.object({
        type:
          z.literal("file"),
      }),
    ],
  );

function modelOnlyMeta():
  Record<string, unknown> {
  return {
    ui: {
      visibility: [
        "model",
      ],
    },
    securitySchemes: [
      {
        type:
          "noauth",
      },
    ],
  };
}

export function registerMcpTurnTools(
  server: McpServer,
  observability:
    McpObservabilityStore,
): void {
  server.registerTool(
    JUNIUS_TURN_BEGIN_TOOL,
    {
      title:
        "Begin Junius turn",
      description:
        "Internal Junius turn boundary. MUST be called as the first Junius tool for every user message that will use Junius. Ordinary Junius tools are refused until this succeeds. Pass the current user input as ordered parts: exact user-authored text parts and one {type:'file'} part for every attached file or image. Do not put file names or file contents into text parts. Junius renders each file part literally as [File]. After the final Junius tool call, MUST call junius_turn_end before the final assistant answer.",
      inputSchema:
        z.object({
          parts:
            z.array(
              promptPartSchema,
            )
              .min(1)
              .max(128),
        }),
      _meta:
        modelOnlyMeta(),
      annotations: {
        readOnlyHint:
          true,
        destructiveHint:
          false,
        idempotentHint:
          false,
        openWorldHint:
          false,
      },
    },
    async (
      {
        parts,
      },
      context,
    ) => {
      const identity =
        extractOpenAiRequestIdentity(
          context.mcpReq._meta,
        );

      if (
        identity.sessionId ===
        undefined
      ) {
        return {
          isError: true,
          content: [
            {
              type:
                "text" as const,
              text:
                "Cannot begin a Junius turn because ChatGPT did not provide a conversation session id.",
            },
          ],
        };
      }

      const turnId =
        observability.beginTurn(
          identity.sessionId,
          parts,
        );

      return {
        content: [
          {
            type:
              "text" as const,
            text:
              "Junius turn started. After the final Junius tool call for this user message, call junius_turn_end before the final assistant answer.",
          },
        ],
        structuredContent: {
          turnId,
        },
      };
    },
  );

  server.registerTool(
    JUNIUS_TURN_END_TOOL,
    {
      title:
        "End Junius turn",
      description:
        "Internal Junius turn boundary. MUST be called after the final Junius tool call for the current user message and before the final assistant answer. Do not leave a completed user request with an active Junius turn.",
      inputSchema:
        z.object({}),
      _meta:
        modelOnlyMeta(),
      annotations: {
        readOnlyHint:
          true,
        destructiveHint:
          false,
        idempotentHint:
          true,
        openWorldHint:
          false,
      },
    },
    async (
      _args,
      context,
    ) => {
      const identity =
        extractOpenAiRequestIdentity(
          context.mcpReq._meta,
        );

      if (
        identity.sessionId ===
        undefined
      ) {
        return {
          isError: true,
          content: [
            {
              type:
                "text" as const,
              text:
                "Cannot end a Junius turn because ChatGPT did not provide a conversation session id.",
            },
          ],
        };
      }

      const turnId =
        observability.endTurn(
          identity.sessionId,
        );

      return {
        content: [],
        structuredContent: {
          ended:
            turnId !== undefined,
          ...(turnId ===
          undefined
            ? {}
            : { turnId }),
        },
      };
    },
  );
}
