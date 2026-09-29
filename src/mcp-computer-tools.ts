import type { McpServer } from "@modelcontextprotocol/server";
import type { AuditStore } from "./audit-store.js";
import { z } from "zod";
import type {
  PlaywrightCliService,
} from "./playwright-cli.js";
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
  playwrightCliToolError,
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

export function registerComputerTools(
  server: McpServer,
  playwrightCli: PlaywrightCliService,
  desktop: DesktopComputerUseService,
  audit?: AuditStore,
): void {
  server.registerTool(
    "playwright_cli",
    {
      title: "Use Local Playwright CLI",
      description:
        "Drive the local browser through the installed Playwright CLI with unrestricted command and argument passthrough. Before the first playwright_cli call in a task, load the browser contract with load_junius_contracts unless it is already loaded. Junius injects only the named session option (-s=<session>) and otherwise forwards the command and argument vector unchanged.",
      inputSchema: z.object({
        session: stableIdSchema
          .default("junius")
          .describe(
            "Named playwright-cli browser session. Sessions are isolated from each other.",
          ),
        command: z
          .string()
          .min(1)
          .max(4_096)
          .describe(
            "Any command supported by the installed Playwright CLI.",
          ),
        args: z
          .array(
            z.string().max(
              65_536,
            ),
          )
          .max(256)
          .default([])
          .describe(
            "Argument vector forwarded unchanged after the Playwright CLI command.",
          ),
      }),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ session, command, args }) => {
      const startedAt = performance.now();
      try {
        const execution = await playwrightCli.run(
          session,
          command,
          args,
        );

        audit?.record({
          category: "browser",
          action: command,
          status: "succeeded",
          subject: session,
          durationMs:
            execution.durationMs,
          metadata: {
            argCount:
              args.length,
            transport:
              execution.transport,
          },
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                execution,
              }),
            },
          ],
        };
      } catch (error) {
        audit?.record({
          category: "browser",
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
          metadata: {
            argCount:
              args.length,
          },
        });
        return playwrightCliToolError(error);
      }
    },
  );

  server.registerTool(
    "desktop",
    {
      title: "Use Local Desktop",
      description:
        "Drive the local Windows desktop through screenshot-based Junius computer use. Before the first desktop tool call in a task, load the desktop contract with load_junius_contracts unless it is already loaded. The tool exposes control lifecycle, screenshot, window, mouse, keyboard, key_macro, clipboard, drag, wait, and action_batch primitives.",
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
