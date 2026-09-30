import {
  createHash,
} from "node:crypto";
import type {
  McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  JUNIUS_PROMPT_NAMES,
  readJuniusPrompt,
  resetJuniusPrompt,
  setJuniusPrompt,
  type JuniusPrompt,
  type JuniusPromptName,
} from "./junius-prompt-store.js";

function promptResult(
  prompt: JuniusPrompt,
) {
  return {
    prompt:
      prompt.name,
    source:
      prompt.source,
    path:
      prompt.path,
    digest:
      createHash("sha256")
        .update(
          prompt.text,
          "utf8",
        )
        .digest("hex"),
  };
}

function activationNote(
  name: JuniusPromptName,
): string {
  return name === "core"
    ? "The override is persisted immediately. New MCP sessions receive the updated Core instructions; an already initialized MCP session keeps the Core instructions it received during initialization."
    : "The override is persisted immediately and the next load_junius_contracts call reads it.";
}

export function registerPromptTools(
  server: McpServer,
): void {
  server.registerTool(
    "get_junius_prompts",
    {
      title:
        "Get Junius Prompts",
      description:
        "Read Junius prompt contracts, including whether each prompt currently comes from the packaged default or a persistent user override. User overrides live outside the application directory and survive Junius updates.",
      inputSchema: z.object({
        prompts: z
          .array(
            z.enum(
              JUNIUS_PROMPT_NAMES,
            ),
          )
          .min(1)
          .max(4)
          .optional(),
      }),
      _meta: {
        securitySchemes: [
          { type: "noauth" },
        ],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ prompts }) => {
      const names =
        prompts ??
        JUNIUS_PROMPT_NAMES;
      const loaded =
        names.map(
          (name) =>
            readJuniusPrompt(
              name,
            ),
        );

      return {
        content: [
          {
            type:
              "text" as const,
            text:
              JSON.stringify({
                ok: true,
                prompts:
                  loaded.map(
                    (prompt) => ({
                      ...promptResult(
                        prompt,
                      ),
                      content:
                        prompt.text,
                    }),
                  ),
              }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "set_junius_prompt",
    {
      title:
        "Set Junius Prompt",
      description:
        "Create or replace one persistent Junius user prompt override. The override is stored outside the installed application directory, so updating Junius does not overwrite it.",
      inputSchema: z.object({
        prompt: z.enum(
          JUNIUS_PROMPT_NAMES,
        ),
        content: z
          .string()
          .max(262_144),
      }),
      _meta: {
        securitySchemes: [
          { type: "noauth" },
        ],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      prompt,
      content,
    }) => {
      const stored =
        setJuniusPrompt(
          prompt,
          content,
        );

      return {
        content: [
          {
            type:
              "text" as const,
            text:
              JSON.stringify({
                ok: true,
                ...promptResult(
                  stored,
                ),
                activation:
                  activationNote(
                    prompt,
                  ),
              }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "reset_junius_prompt",
    {
      title:
        "Reset Junius Prompt",
      description:
        "Delete one persistent Junius user prompt override and return that prompt to the packaged default supplied by the installed Junius version.",
      inputSchema: z.object({
        prompt: z.enum(
          JUNIUS_PROMPT_NAMES,
        ),
      }),
      _meta: {
        securitySchemes: [
          { type: "noauth" },
        ],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ prompt }) => {
      const fallback =
        resetJuniusPrompt(
          prompt,
        );

      return {
        content: [
          {
            type:
              "text" as const,
            text:
              JSON.stringify({
                ok: true,
                ...promptResult(
                  fallback,
                ),
                activation:
                  activationNote(
                    prompt,
                  ),
              }),
          },
        ],
      };
    },
  );
}
