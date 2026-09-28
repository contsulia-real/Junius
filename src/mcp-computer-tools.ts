import type { McpServer } from "@modelcontextprotocol/server";
import type { AuditStore } from "./audit-store.js";
import { z } from "zod";
import {
  PLAYWRIGHT_CLI_COMMANDS,
  type PlaywrightCliService,
} from "./playwright-cli.js";
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

function browserAuditArgs(
  command: string,
  args: readonly string[],
): readonly string[] {
  if (
    command === "fill" ||
    command === "type"
  ) {
    return args.map(
      (value, index) =>
        index === 0
          ? value
          : "[REDACTED]",
    );
  }

  if (
    (command === "open" ||
      command === "goto") &&
    args[0] !== undefined
  ) {
    try {
      const url = new URL(args[0]);
      return [
        url.origin + url.pathname,
        ...args.slice(1),
      ];
    } catch {
      return ["[URL]"];
    }
  }

  return [...args];
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
        "Drive the local browser through the installed playwright-cli. This is a thin adapter over playwright-cli named sessions. Use snapshot to get element refs before element interactions. When the user's browser task is complete, close the same session before giving the final answer unless the user explicitly asks to leave the browser open. Closing the session does not discard its persistent profile/login state. The adapter only allows normal browser-navigation and interaction commands; eval, run-code, storage manipulation, CDP attach, request interception, and arbitrary CLI commands are not exposed.",
      inputSchema: z.object({
        session: stableIdSchema
          .default("junius")
          .describe(
            "Named playwright-cli browser session. Sessions are isolated from each other.",
          ),
        command: z.enum(PLAYWRIGHT_CLI_COMMANDS),
        args: z
          .array(z.string().max(4_096))
          .max(8)
          .default([])
          .describe(
            "Arguments for the selected allowed playwright-cli command. Use element refs such as e15 for element interactions.",
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
            args:
              browserAuditArgs(
                command,
                args,
              ),
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
            args:
              browserAuditArgs(
                command,
                args,
              ),
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
        "Drive the local Windows desktop through screenshot-based Junius computer use. For every desktop-control task, call control_begin once before the first desktop action and always call control_end for the same session before finishing, including when the task succeeds, cannot be completed, or encounters an error. The user-visible Junius takeover indicator remains active for that entire control scope. Use windows to discover top-level native windows, screenshot to understand the full screen or one window, coordinate mouse/keyboard commands to act, key_macro for bounded keyboard sequences, and clipboard_read/clipboard_write for Unicode text clipboard access. Screenshot coordinates are window-relative when a handle is supplied and screen-relative otherwise.",
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
        button: z.enum(["left", "right", "middle"]).optional(),
        clicks: z.number().int().min(1).max(4).optional(),
        amount: z.number().int().optional(),
        key: z.string().min(1).max(64).optional(),
        text: z.string().max(65_536).optional(),
        steps: z
          .array(
            z.object({
              action: z.enum(
                DESKTOP_KEY_MACRO_ACTIONS,
              ),
              key: z
                .string()
                .min(1)
                .max(64),
            }),
          )
          .min(1)
          .max(128)
          .optional()
          .describe(
            "Keyboard macro steps executed locally in order. Any key_down still held by this macro is released before the macro returns, including on failure.",
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
      key,
      text,
      steps,
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
        ...(key === undefined
          ? {}
          : { key }),
        ...(text === undefined
          ? {}
          : { text: "[REDACTED]" }),
        ...(steps === undefined
          ? {}
          : { stepCount: steps.length }),
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
          ...(key === undefined ? {} : { key }),
          ...(text === undefined ? {} : { text }),
          ...(steps === undefined ? {} : { steps }),
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
