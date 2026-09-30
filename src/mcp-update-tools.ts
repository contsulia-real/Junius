import type {
  McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  checkJuniusUpdate,
  updateJunius,
} from "../scripts/update.mjs";
import {
  JUNIUS_VERSION,
} from "./project-version.js";

export function registerUpdateTools(
  server: McpServer,
): void {
  server.registerTool(
    "check_junius_update",
    {
      title:
        "Check Junius Update",
      description:
        "Check the newest published Junius GitHub Release against the currently running installed Junius version. This performs network access but does not install or modify anything.",
      inputSchema:
        z.object({}),
      _meta: {
        securitySchemes: [
          { type: "noauth" },
        ],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const result =
          await checkJuniusUpdate({
            currentVersion:
              JUNIUS_VERSION,
          });

        return {
          content: [
            {
              type:
                "text" as const,
              text:
                JSON.stringify({
                  ok: true,
                  ...result,
                }),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type:
                "text" as const,
              text:
                JSON.stringify({
                  ok: false,
                  message:
                    error instanceof
                    Error
                      ? error.message
                      : String(
                          error,
                        ),
                }),
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "update_junius",
    {
      title:
        "Update Junius",
      description:
        "Update the installed Junius copy to the newest published GitHub Release using the same verified release bootstrap as installation. When invoked through Junius itself, the update is installed and validated without terminating the active MCP call; restart Junius afterward to activate the new version.",
      inputSchema:
        z.object({}),
      _meta: {
        securitySchemes: [
          { type: "noauth" },
        ],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const result =
          await updateJunius({
            currentVersion:
              JUNIUS_VERSION,
          });

        return {
          content: [
            {
              type:
                "text" as const,
              text:
                JSON.stringify({
                  ok: true,
                  ...result,
                }),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type:
                "text" as const,
              text:
                JSON.stringify({
                  ok: false,
                  message:
                    error instanceof
                    Error
                      ? error.message
                      : String(
                          error,
                        ),
                }),
            },
          ],
        };
      }
    },
  );
}
