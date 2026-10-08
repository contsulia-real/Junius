import type {
  McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { ComputerPermissionManager, closeComputerSessions } from "./mcp-computer-permission.js";
import type { PlaywrightCliService } from "./playwright-cli.js";
import type { DesktopComputerUseService } from "./desktop-computer-use.js";
import type {
  McpObservabilityStore,
} from "./mcp-observability.js";
import {
  observabilitySessionId,
} from "./mcp-session-context.js";

export const JUNIUS_TURN_BEGIN_TOOL =
  "junius_turn_begin";
export const JUNIUS_TURN_END_TOOL =
  "junius_turn_end";
export const JUNIUS_TASK_REVIEW_TOOL =
  "junius_task_review";

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
  permissions = new ComputerPermissionManager(),
  browser?: PlaywrightCliService,
  desktop?: DesktopComputerUseService,
): void {
  server.registerTool(
    JUNIUS_TURN_BEGIN_TOOL,
    {
      title:
        "Begin Junius turn",
      description:
        "Internal Junius turn boundary. MUST be called as the first Junius tool for every user message that will use Junius. Ordinary Junius tools are refused until this succeeds. Pass the current user input as ordered parts: exact user-authored text parts and one {type:'file'} part for every attached file or image. Do not put file names or file contents into text parts. Junius renders each file part literally as [File]. After this succeeds, call list_skills and read_skill for applicable Skills. Inspect relevant context before consequential work, then call junius_task_review with the goal, scope, risks, and verification. Read-only discovery is allowed without a review. After the final Junius tool call, MUST call junius_turn_end before the final assistant answer.",
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
      const sessionId =
        observabilitySessionId(
          context.mcpReq._meta,
        );

      if (
        sessionId ===
        undefined
      ) {
        return {
          isError: true,
          content: [
            {
              type:
                "text" as const,
              text:
                "Cannot begin a Junius turn because no MCP transport session or ChatGPT conversation session is available.",
            },
          ],
        };
      }

      const locale =
        (
          context.mcpReq._meta as
            | Record<string, unknown>
            | undefined
        )?.["openai/locale"];

      if (browser && desktop) {
        await closeComputerSessions(permissions.endTurn(sessionId), browser, desktop);
      } else {
        permissions.endTurn(sessionId);
      }
      permissions.beginTurn(sessionId);
      const turnId =
        observability.beginTurn(
          sessionId,
          parts,
          typeof locale === "string"
            ? locale
            : undefined,
        );

      return {
        content: [
          {
            type:
              "text" as const,
            text:
              "Junius turn started. Read applicable Skills and inspect relevant context. Before any consequential tool, call junius_task_review with objective, scope, risks, and verification; this does not replace Browser/Desktop consent. After the final Junius tool call, call junius_turn_end before the final answer.",
          },
        ],
        structuredContent: {
          turnId,
        },
      };
    },
  );

  server.registerTool(
    JUNIUS_TASK_REVIEW_TOOL,
    {
      title:
        "Review Task Before Execution",
      description:
        "Required before consequential Junius tools in the current turn. After inspecting relevant context, state the user's real goal, the chosen work boundary (including what stays untouched), material risks/alternative paths, and how the original problem will be verified. This records a review checkpoint; it is NOT a user approval, an independent assessment of correctness, or permission to use Browser/Desktop. Read-only discovery is allowed before review. A new turn requires a new review.",
      inputSchema:
        z.object({
          objective:
            z.string().trim().min(8).max(4096),
          scope:
            z.string().trim().min(8).max(4096),
          risks:
            z.string().trim().min(8).max(4096),
          verification:
            z.string().trim().min(8).max(4096),
        }),
      _meta:
        modelOnlyMeta(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ objective, scope, risks, verification }, context) => {
      const sessionId =
        observabilitySessionId(context.mcpReq._meta);
      if (
        sessionId === undefined ||
        !observability.markTaskReviewed(sessionId)
      ) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: "Begin the current Junius turn before reviewing it.",
          }],
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: "Task review recorded for this turn. This is not user approval or proof that the design is correct. Execute only within the stated scope, verify the actual outcome, and respect independent Browser/Desktop consent.",
        }],
        structuredContent: {
          reviewed: true,
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
      const sessionId =
        observabilitySessionId(
          context.mcpReq._meta,
        );

      if (
        sessionId ===
        undefined
      ) {
        return {
          isError: true,
          content: [
            {
              type:
                "text" as const,
              text:
                "Cannot end a Junius turn because no MCP transport session or ChatGPT conversation session is available.",
            },
          ],
        };
      }

      const turnId =
        observability.endTurn(
          sessionId,
        );
      if (browser && desktop) {
        await closeComputerSessions(permissions.endTurn(sessionId), browser, desktop);
      } else {
        permissions.endTurn(sessionId);
      }

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
