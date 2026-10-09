import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AuditStore } from "./audit-store.js";
import type { PlaywrightCliService } from "./playwright-cli.js";
import type { McpObservabilityStore } from "./mcp-observability.js";
import { observabilitySessionId } from "./mcp-session-context.js";
import { ComputerSessionManager } from "./mcp-computer-sessions.js";
import { playwrightCliToolError, stableIdSchema } from "./mcp-tool-shared.js";

export function registerBrowserTool(
  server: McpServer,
  playwrightCli: PlaywrightCliService,
  sessions: ComputerSessionManager,
  observability: McpObservabilityStore,
  audit?: AuditStore,
): void {
  server.registerTool(
    "playwright_cli",
    {
      title: "Use Local Playwright CLI",
      description:
        "Use the local Playwright browser directly for the user's task. Sessions are isolated by Chat, and close ends the named session. Close the named session when the browser task is finished. No separate Junius consent panel.",
      inputSchema: z.object({
        session: stableIdSchema.default("junius")
          .describe("Browser session name within this Chat (never shared across Chats)."),
        command: z.string().min(1).max(4_096),
        args: z.array(z.string().max(65_536)).max(256).default([]),
      }),
      annotations: {
        readOnlyHint: false, destructiveHint: true,
        idempotentHint: false, openWorldHint: true,
      },
    },
    async ({ session, command, args }, context) => {
      const chat = observabilitySessionId(context.mcpReq._meta);
      const turnId = chat === undefined ? undefined : observability.activeTurnId(chat);
      if (!chat || !turnId) {
        return { isError: true, content: [{ type: "text" as const, text: "Junius turn identity is required before browser access." }] };
      }
      const actualSession = sessions.session(chat, session ?? "junius");
      sessions.track(chat, "browser", actualSession);
      const startedAt = performance.now();
      try {
        const execution = await playwrightCli.run(actualSession, command, args);
        if (command === "close") sessions.untrack(chat, "browser", actualSession);
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
