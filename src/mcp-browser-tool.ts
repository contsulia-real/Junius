import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AuditStore } from "./audit-store.js";
import type {
  PlaywrightCliService,
} from "./playwright-cli.js";
import {
  playwrightCliToolError,
  stableIdSchema,
} from "./mcp-tool-shared.js";

export function registerBrowserTool(
  server: McpServer,
  playwrightCli: PlaywrightCliService,
  audit?: AuditStore,
): void {
  server.registerTool(
    "playwright_cli",
    {
      title: "Use Local Playwright CLI",
      description:
        "Drive the local browser through the installed Playwright CLI with unrestricted command and argument passthrough. PRIVACY BOUNDARY: do not call this tool unless the current user's request explicitly asks ChatGPT to control the browser. This includes read-only inspection. The first Browser call for a session must assert explicit_user_authorization=true; once accepted, subsequent calls for that active session must omit it even if an individual Browser command fails. close revokes authorization. Previous authorization does not carry forward.",
      inputSchema: z.object({
        explicit_user_authorization: z
          .literal(true)
          .optional()
          .describe(
            "Privacy assertion for the first Browser call in the current user-authorized task. Set to true only when the current user request explicitly asks ChatGPT to control the browser. Omit it after the session is authorized and on close.",
          ),
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
    async ({
      explicit_user_authorization,
      session,
      command,
      args,
    }) => {
      const startedAt = performance.now();
      try {
        const execution = await playwrightCli.run(
          session,
          command,
          args,
          explicit_user_authorization,
        );

        audit?.record({
          category: "browser",
          action: command,
          status: "succeeded",
          subject: session,
          durationMs:
            execution.durationMs,
          metadata: {
            ...(explicit_user_authorization ===
            undefined
              ? {}
              : {
                  explicitUserAuthorization:
                    explicit_user_authorization,
                }),
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
            ...(explicit_user_authorization ===
            undefined
              ? {}
              : {
                  explicitUserAuthorization:
                    explicit_user_authorization,
                }),
            argCount:
              args.length,
          },
        });
        return playwrightCliToolError(error);
      }
    },
  );
}
