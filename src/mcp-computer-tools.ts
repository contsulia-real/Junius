import type { McpServer } from "@modelcontextprotocol/server";
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

export function registerComputerTools(
  server: McpServer,
  playwrightCli: PlaywrightCliService,
  desktop: DesktopComputerUseService,
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
      try {
        const execution = await playwrightCli.run(
          session,
          command,
          args,
        );

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
        return desktopToolError(error);
      }
    },
  );

}
