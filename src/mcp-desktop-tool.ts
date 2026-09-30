import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AuditStore } from "./audit-store.js";
import type {
  DesktopBatchAction,
} from "./desktop-computer-use.js";
import {
  DESKTOP_COMMANDS,
  DESKTOP_KEY_MACRO_ACTIONS,
  type DesktopComputerUseService,
} from "./desktop-computer-use.js";
import {
  desktopToolError,
  stableIdSchema,
} from "./mcp-tool-shared.js";

const desktopKeyMacroStepSchema =
  z.object({
    action: z.enum(
      DESKTOP_KEY_MACRO_ACTIONS,
    ),
    key: z
      .string()
      .min(1)
      .max(64),
  });

const desktopPointFields = {
  handle: z
    .number()
    .int()
    .positive()
    .optional(),
  x: z.number().int(),
  y: z.number().int(),
};

const desktopBatchActionSchema =
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal(
        "focus_window",
      ),
      handle: z
        .number()
        .int()
        .positive(),
    }),
    z.object({
      action: z.literal(
        "mouse_move",
      ),
      ...desktopPointFields,
    }),
    z.object({
      action: z.literal(
        "mouse_click",
      ),
      ...desktopPointFields,
      button: z
        .enum([
          "left",
          "right",
          "middle",
        ])
        .optional(),
      clicks: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional(),
    }),
    z.object({
      action: z.enum([
        "mouse_down",
        "mouse_up",
      ]),
      ...desktopPointFields,
      button: z
        .enum([
          "left",
          "right",
          "middle",
        ])
        .optional(),
    }),
    z.object({
      action: z.literal(
        "mouse_wheel",
      ),
      ...desktopPointFields,
      amount: z
        .number()
        .int(),
    }),
    z.object({
      action: z.literal("drag"),
      ...desktopPointFields,
      to_x: z.number().int(),
      to_y: z.number().int(),
      button: z
        .enum([
          "left",
          "right",
          "middle",
        ])
        .optional(),
      duration_ms: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .optional(),
    }),
    z.object({
      action: z.literal("wait"),
      duration_ms: z
        .number()
        .int()
        .min(0)
        .max(30_000),
    }),
    z.object({
      action: z.enum([
        "key_press",
        "key_down",
        "key_up",
      ]),
      key: z
        .string()
        .min(1)
        .max(64),
    }),
    z.object({
      action: z.literal(
        "key_macro",
      ),
      steps: z
        .array(
          desktopKeyMacroStepSchema,
        )
        .min(1)
        .max(128),
    }),
    z.object({
      action: z.literal(
        "clipboard_read",
      ),
    }),
    z.object({
      action: z.enum([
        "clipboard_write",
        "type",
      ]),
      text: z
        .string()
        .max(65_536),
    }),
  ]);

type DesktopBatchActionInput =
  z.infer<
    typeof desktopBatchActionSchema
  >;

function toDesktopBatchAction(
  action: DesktopBatchActionInput,
): DesktopBatchAction {
  switch (action.action) {
    case "drag":
      return {
        action: "drag",
        ...(action.handle === undefined
          ? {}
          : {
              handle:
                action.handle,
            }),
        x: action.x,
        y: action.y,
        toX: action.to_x,
        toY: action.to_y,
        ...(action.button === undefined
          ? {}
          : {
              button:
                action.button,
            }),
        ...(action.duration_ms ===
        undefined
          ? {}
          : {
              durationMs:
                action.duration_ms,
            }),
      };

    case "wait":
      return {
        action: "wait",
        durationMs:
          action.duration_ms,
      };

    default:
      return action;
  }
}

export function registerDesktopTool(
  server: McpServer,
  desktop: DesktopComputerUseService,
  audit?: AuditStore,
): void {
  server.registerTool(
    "desktop",
    {
      title: "Use Local Desktop",
      description:
        "Drive the local Windows desktop through screenshot-based Junius computer use. PRIVACY BOUNDARY: do not call this tool unless the current user's request explicitly asks ChatGPT to control the local computer. This includes read-only access such as windows, screenshot, and clipboard_read. Authorization is established only by a successful control_begin with explicit_user_authorization=true for that session; subsequent calls rely on that active session and must not repeat the assertion. control_end revokes it. Previous authorization does not carry forward.",
      inputSchema: z.object({
        explicit_user_authorization: z
          .literal(true)
          .optional()
          .describe(
            "Privacy assertion used only with control_begin. Set to true only when the current user's request explicitly asks ChatGPT to control this local computer. Omit it for every other command.",
          ),
        session: stableIdSchema
          .default("junius")
          .describe(
            "Named Junius desktop control scope. Use the same session from control_begin through control_end; it is also recorded for audit/tracing.",
          ),
        command: z.enum(DESKTOP_COMMANDS),
        handle: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Top-level native window handle. For screenshot and mouse commands, coordinates become relative to this window when supplied.",
          ),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        to_x: z.number().int().optional(),
        to_y: z.number().int().optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
        clicks: z.number().int().min(1).max(4).optional(),
        amount: z.number().int().optional(),
        duration_ms: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional(),
        key: z.string().min(1).max(64).optional(),
        text: z.string().max(65_536).optional(),
        steps: z
          .array(
            desktopKeyMacroStepSchema,
          )
          .min(1)
          .max(128)
          .optional()
          .describe(
            "Keyboard macro steps executed locally in order. Any key_down still held by this macro is released before the macro returns, including on failure.",
          ),
        actions: z
          .array(
            desktopBatchActionSchema,
          )
          .min(1)
          .max(128)
          .optional()
          .describe(
            "Mixed Desktop actions for action_batch. Total wait time is bounded to 30 seconds.",
          ),
        screenshot_after: z
          .boolean()
          .optional()
          .describe(
            "For action_batch, capture and return a screenshot after all actions complete.",
          ),
        screenshot_handle: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional top-level window handle for action_batch screenshot_after.",
          ),
      }),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      explicit_user_authorization,
      session,
      command,
      handle,
      x,
      y,
      button,
      clicks,
      amount,
      duration_ms,
      to_x,
      to_y,
      key,
      text,
      steps,
      actions,
      screenshot_after,
      screenshot_handle,
    }) => {
      const startedAt = performance.now();
      const auditMetadata = {
        ...(explicit_user_authorization ===
        undefined
          ? {}
          : {
              explicitUserAuthorization:
                explicit_user_authorization,
            }),
        ...(handle === undefined
          ? {}
          : { handle }),
        ...(x === undefined
          ? {}
          : { x }),
        ...(y === undefined
          ? {}
          : { y }),
        ...(button === undefined
          ? {}
          : { button }),
        ...(clicks === undefined
          ? {}
          : { clicks }),
        ...(amount === undefined
          ? {}
          : { amount }),
        ...(duration_ms === undefined
          ? {}
          : { durationMs: duration_ms }),
        ...(to_x === undefined
          ? {}
          : { toX: to_x }),
        ...(to_y === undefined
          ? {}
          : { toY: to_y }),
        ...(key === undefined
          ? {}
          : { key }),
        ...(text === undefined
          ? {}
          : { text: "[REDACTED]" }),
        ...(steps === undefined
          ? {}
          : { stepCount: steps.length }),
        ...(actions === undefined
          ? {}
          : { actionCount: actions.length }),
        ...(screenshot_after === undefined
          ? {}
          : { screenshotAfter: screenshot_after }),
        ...(screenshot_handle === undefined
          ? {}
          : { screenshotHandle: screenshot_handle }),
      };

      try {
        const execution = await desktop.run({
          session,
          command,
          ...(explicit_user_authorization ===
          undefined
            ? {}
            : {
                explicitUserAuthorization:
                  explicit_user_authorization,
              }),
          ...(handle === undefined ? {} : { handle }),
          ...(x === undefined ? {} : { x }),
          ...(y === undefined ? {} : { y }),
          ...(button === undefined ? {} : { button }),
          ...(clicks === undefined ? {} : { clicks }),
          ...(amount === undefined ? {} : { amount }),
          ...(duration_ms === undefined
            ? {}
            : { durationMs: duration_ms }),
          ...(to_x === undefined ? {} : { toX: to_x }),
          ...(to_y === undefined ? {} : { toY: to_y }),
          ...(key === undefined ? {} : { key }),
          ...(text === undefined ? {} : { text }),
          ...(steps === undefined ? {} : { steps }),
          ...(actions === undefined
            ? {}
            : {
                actions:
                  actions.map(
                    toDesktopBatchAction,
                  ),
              }),
          ...(screenshot_after === undefined
            ? {}
            : { screenshotAfter: screenshot_after }),
          ...(screenshot_handle === undefined
            ? {}
            : { screenshotHandle: screenshot_handle }),
        });

        audit?.record({
          category: "desktop",
          action: command,
          status: "succeeded",
          subject: session,
          durationMs:
            execution.durationMs,
          metadata: auditMetadata,
        });

        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        > = [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              session: execution.session,
              command: execution.command,
              result: execution.result,
              durationMs: execution.durationMs,
            }),
          },
        ];

        if (execution.image !== undefined) {
          content.push({
            type: "image",
            data: execution.image.data,
            mimeType: execution.image.mimeType,
          });
        }

        return { content };
      } catch (error) {
        audit?.record({
          category: "desktop",
          action: command,
          status: "failed",
          subject: session,
          durationMs:
            performance.now() -
            startedAt,
          summary:
            error instanceof Error
              ? error.message
              : String(error),
          metadata: auditMetadata,
        });
        return desktopToolError(error);
      }
    },
  );
}
