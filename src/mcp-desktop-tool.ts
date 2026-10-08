import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ComputerSessionManager } from "./mcp-computer-sessions.js";
import { observabilitySessionId } from "./mcp-session-context.js";
import type { McpObservabilityStore } from "./mcp-observability.js";
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
  sessions: ComputerSessionManager,
  observability: McpObservabilityStore,
  audit?: AuditStore,
): void {
  server.registerTool(
    "desktop",
    {
      title: "Use Local Desktop",
      description:
        "Use the local Windows desktop directly for a user task, including screenshots, windows, clipboard and input. control_begin may be called first, but Junius automatically starts a Chat-scoped desktop control session; control_end closes it. Stop after physical Escape. No separate Junius consent panel.",
      inputSchema: z.object({
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
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
    }, context) => {
      const chat = observabilitySessionId(context.mcpReq._meta);
      const turnId = chat === undefined ? undefined : observability.activeTurnId(chat);
      if (!chat || !turnId) {
        return { isError: true, content: [{ type: "text" as const, text: "Junius turn identity is required before desktop access." }] };
      }
      if (sessions.wasInterrupted(chat, "desktop")) {
        return { isError: true, content: [{ type: "text" as const, text: "Desktop operation was interrupted by Escape; wait for the next user turn." }] };
      }
      const actualSession = sessions.session(chat, session ?? "junius");
      const initial = !sessions.isTracked(chat, "desktop", actualSession);
      const startedAt = performance.now();
      const auditMetadata = {
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
        if (!initial && command !== "control_begin" && command !== "control_end" &&
            typeof desktop.state === "function" && !desktop.state().helperRunning) {
          await desktop.run({ session: actualSession, command: "control_begin" });
        }
        if (initial && command !== "control_begin" && command !== "control_end") {
          await desktop.run({ session: actualSession, command: "control_begin" });
          sessions.track(chat, "desktop", actualSession);
        }
        if (!initial && command === "control_begin") {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, session, command, result: { active: true } }) }] };
        }
        const execution = await desktop.run({
          session: actualSession,
          command,
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

        if (command === "control_begin") sessions.track(chat, "desktop", actualSession);
        if (command === "control_end") sessions.untrack(chat, "desktop", actualSession);
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
              session,
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
        if ((error as { code?: string })?.code === "control_not_started") {
          sessions.untrack(chat, "desktop", actualSession);
        }
        if ((error as { code?: string })?.code === "user_interrupted") {
          sessions.interrupt(chat, "desktop");
          sessions.untrack(chat, "desktop", actualSession);
          await desktop.run({ session: actualSession, command: "control_end" }).catch(() => undefined);
        }
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
