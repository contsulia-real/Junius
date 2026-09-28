import type { McpServer } from "@modelcontextprotocol/server";
import type { AuditStore } from "./audit-store.js";
import { z } from "zod";
import {
  PLAYWRIGHT_CLI_COMMANDS,
  type PlaywrightCliService,
} from "./playwright-cli.js";
import {
  DESKTOP_COMMANDS,
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
        "Drive the local Windows desktop through Junius computer use. Use windows to discover top-level windows. Use inspect on a window to get semantic UI Automation element refs such as d3, then use invoke, set_value, or focus with those refs. For applications without usable UI Automation, including many games and custom-rendered interfaces, use screenshot and coordinate-based mouse/keyboard commands. Screenshot coordinates are window-relative when a handle is supplied and screen-relative otherwise. Element refs are scoped to the named desktop session and are refreshed by inspect.",
      inputSchema: z.object({
        session: stableIdSchema
          .default("junius")
          .describe(
            "Named Junius desktop session. UI Automation element refs are scoped to this session.",
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
        ref: z
          .string()
          .regex(/^d\d+$/u)
          .optional()
          .describe(
            "Desktop element ref returned by inspect, such as d7.",
          ),
        depth: z.number().int().min(0).max(8).optional(),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
        clicks: z.number().int().min(1).max(4).optional(),
        amount: z.number().int().optional(),
        key: z.string().min(1).max(64).optional(),
        text: z.string().max(65_536).optional(),
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
      ref,
      depth,
      x,
      y,
      button,
      clicks,
      amount,
      key,
      text,
    }) => {
      const startedAt = performance.now();
      const auditMetadata = {
        ...(handle === undefined
          ? {}
          : { handle }),
        ...(ref === undefined
          ? {}
          : { ref }),
        ...(depth === undefined
          ? {}
          : { depth }),
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
      };
      try {
        const execution = await desktop.run({
          session,
          command,
          ...(handle === undefined ? {} : { handle }),
          ...(ref === undefined ? {} : { ref }),
          ...(depth === undefined ? {} : { depth }),
          ...(x === undefined ? {} : { x }),
          ...(y === undefined ? {} : { y }),
          ...(button === undefined ? {} : { button }),
          ...(clicks === undefined ? {} : { clicks }),
          ...(amount === undefined ? {} : { amount }),
          ...(key === undefined ? {} : { key }),
          ...(text === undefined ? {} : { text }),
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
