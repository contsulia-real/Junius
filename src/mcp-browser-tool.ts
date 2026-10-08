import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AuditStore } from "./audit-store.js";
import type { PlaywrightCliService } from "./playwright-cli.js";
import type { McpObservabilityStore } from "./mcp-observability.js";
import { observabilitySessionId } from "./mcp-session-context.js";
import { ComputerPermissionManager } from "./mcp-computer-permission.js";
import { playwrightCliToolError, stableIdSchema } from "./mcp-tool-shared.js";

export function registerBrowserTool(
  server: McpServer,
  playwrightCli: PlaywrightCliService,
  permissions: ComputerPermissionManager,
  observability: McpObservabilityStore,
  audit?: AuditStore,
): void {
  server.registerTool(
    "playwright_cli",
    {
      title: "Use Local Playwright CLI",
      description:
        "Use the local browser when it would help complete the user's task. Junius will first present a user-facing choice explaining the purpose and four permission scopes (allow/deny this turn or this Chat). Do not require the user to speak an authorization phrase. Browser inspection also requires consent. Do not use this tool after an Escape interruption during the same turn; do not retry without renewed user consent. Device permission does not authorize independent high-impact actions. close ends the named browser session.",
      inputSchema: z.object({
        session: stableIdSchema.default("junius")
          .describe("Browser session name within this Chat (never shared across Chats)."),
        purpose: z.string().min(8).max(400)
          .describe("Plain-language explanation for the user of why browser access is needed and what you will do."),
        command: z.string().min(1).max(4_096),
        args: z.array(z.string().max(65_536)).max(256).default([]),
      }),
      _meta: { securitySchemes: [{ type: "noauth" }] },
      annotations: {
        readOnlyHint: false, destructiveHint: true,
        idempotentHint: false, openWorldHint: true,
      },
    },
    async ({ session, purpose, command, args }, context) => {
      const chat = observabilitySessionId(context.mcpReq._meta);
      const turnId = chat === undefined ? undefined : observability.activeTurnId(chat);
      if (!chat || !turnId) {
        return { isError: true, content: [{ type: "text" as const, text: "Junius turn identity is required before browser access." }] };
      }
      const choice = permissions.authorize(chat, turnId, "browser",
        purpose ?? `运行浏览器命令 ${command}`, context);
      if (choice !== true) {
        return choice === false
          ? { isError: true, content: [{ type: "text" as const, text: "Browser permission denied for this Chat or turn." }] }
          : choice;
      }

      const actualSession = permissions.session(chat, session ?? "junius");
      const initial = !permissions.isTracked(chat, "browser", actualSession);
      permissions.track(chat, "browser", actualSession);
      const startedAt = performance.now();
      try {
        let execution;
        try {
          execution = await playwrightCli.run(
            actualSession, command, args, initial ? true : undefined,
          );
        } catch (error) {
          // An idle browser session may have expired while Chat-level consent remains valid.
          if (initial || (error as { code?: string })?.code !== "authorization_required") throw error;
          execution = await playwrightCli.run(actualSession, command, args, true);
        }
        if (command === "close") permissions.untrack(chat, "browser", actualSession);
        audit?.record({
          category: "browser", action: command, status: "succeeded",
          subject: actualSession, durationMs: execution.durationMs,
          metadata: { argCount: args.length, transport: execution.transport },
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ ok: true, execution: { ...execution, session } }),
          }],
        };
      } catch (error) {
        if ((error as { code?: string })?.code === "user_interrupted") {
          permissions.interrupt(chat, "browser");
          permissions.untrack(chat, "browser", actualSession);
          await playwrightCli.run(actualSession, "close", []).catch(() => undefined);
        }
        audit?.record({
          category: "browser", action: command, status: "failed",
          subject: actualSession, durationMs: performance.now() - startedAt,
          summary: error instanceof Error ? error.message : String(error),
          metadata: { argCount: args.length },
        });
        return playwrightCliToolError(error);
      }
    },
  );
}
