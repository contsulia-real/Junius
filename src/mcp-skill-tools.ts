import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  SkillError,
  SkillService,
} from "./skill-service.js";
import {
  WorkspaceFileError,
} from "./workspace-files.js";
import {
  stableIdSchema,
} from "./mcp-tool-shared.js";

const skillNameSchema = z
  .string()
  .min(1)
  .max(128);

const skillScopeSchema = z.enum([
  "global",
  "workspace",
]);

const agentsDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .optional()
  .describe(
    "Digest returned by an AGENTS.md preflight. Required for Workspace-scoped installation/removal when applicable instructions exist.",
  );

function skillToolError(
  error: unknown,
) {
  if (
    error instanceof SkillError ||
    error instanceof
      WorkspaceFileError
  ) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            code: error.code,
            message:
              error.message,
            ...(
              "details" in error &&
              error.details !==
                undefined
                ? {
                    details:
                      error.details,
                  }
                : {}
            ),
          }),
        },
      ],
    };
  }

  throw error;
}

function success(
  payload: object,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: true,
          ...payload,
        }),
      },
    ],
  };
}

export function registerSkillTools(
  server: McpServer,
  skills: SkillService,
): void {
  server.registerTool(
    "list_skills",
    {
      title:
        "List Local Agent Skills",
      description:
        "List standard local Agent Skills. Without a workspace, returns global skills from %USERPROFILE%\\.agents\\skills. With a registered Workspace, also returns <workspace>\\.agents\\skills; a Workspace skill with the same name overrides the global skill. Only metadata is returned so full SKILL.md content can be loaded on demand with read_skill.",
      inputSchema: z.object({
        workspace:
          stableIdSchema
            .optional()
            .describe(
              "Optional registered Workspace ID. When supplied, Workspace skills are included and override same-name global skills.",
            ),
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
    async ({ workspace }) => {
      try {
        const result =
          await skills.list(
            workspace,
          );
        return success({
          workspace,
          ...result,
        });
      } catch (error) {
        return skillToolError(
          error,
        );
      }
    },
  );

  server.registerTool(
    "read_skill",
    {
      title:
        "Read Local Agent Skill",
      description:
        "Read SKILL.md or another UTF-8 text file inside a local Agent Skill. By default resolves the effective skill (Workspace first, then global). Use scope to inspect an explicitly global or Workspace copy. Paths cannot escape the selected skill directory.",
      inputSchema: z.object({
        name:
          skillNameSchema,
        workspace:
          stableIdSchema
            .optional(),
        scope: z
          .enum([
            "effective",
            "global",
            "workspace",
          ])
          .default(
            "effective",
          ),
        path: z
          .string()
          .min(1)
          .max(4_096)
          .default("SKILL.md"),
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
    async ({
      name,
      workspace,
      scope,
      path,
    }) => {
      try {
        const result =
          await skills.read({
            name,
            workspace,
            scope,
            path,
          });
        return success({
          skill: result,
        });
      } catch (error) {
        return skillToolError(
          error,
        );
      }
    },
  );

  server.registerTool(
    "install_skill",
    {
      title:
        "Install Local Agent Skill",
      description:
        "Install one standard Agent Skill into global or Workspace scope. Source may be a local directory, local archive, HTTP(S) archive, GitHub repository URL, or GitHub tree/blob URL. Junius downloads/extracts remote sources, locates and validates SKILL.md, stages the complete skill directory, and installs it as one operation. Use subpath to select one skill from a repository/archive. Existing targets are rejected unless replace=true.",
      inputSchema: z.object({
        source: z
          .string()
          .min(1)
          .max(8_192)
          .describe(
            "Absolute local path, Workspace-relative local path, HTTP(S) archive URL, GitHub repository URL, or GitHub tree/blob URL.",
          ),
        scope:
          skillScopeSchema,
        workspace:
          stableIdSchema
            .optional()
            .describe(
              "Registered Workspace ID. Required for Workspace scope. Also supplies the base directory for a relative local source.",
            ),
        subpath: z
          .string()
          .min(1)
          .max(4_096)
          .optional()
          .describe(
            "Optional directory inside the supplied source, useful when a repository/archive contains multiple skills.",
          ),
        replace: z
          .boolean()
          .default(false),
        agents_digest:
          agentsDigestSchema,
      }),
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
    async ({
      source,
      scope,
      workspace,
      subpath,
      replace,
      agents_digest,
    }) => {
      try {
        const installed =
          await skills.install({
            source,
            scope,
            workspace,
            subpath,
            replace,
            agentsDigest:
              agents_digest,
          });
        return success({
          installed,
        });
      } catch (error) {
        return skillToolError(
          error,
        );
      }
    },
  );

  server.registerTool(
    "remove_skill",
    {
      title:
        "Remove Local Agent Skill",
      description:
        "Remove one local Agent Skill from an explicit global or Workspace scope. Removing a Workspace skill can reveal a same-name global skill again; the result reports the effective skill after removal when one exists.",
      inputSchema: z.object({
        name:
          skillNameSchema,
        scope:
          skillScopeSchema,
        workspace:
          stableIdSchema
            .optional()
            .describe(
              "Registered Workspace ID. Required when removing a Workspace-scoped skill; may also be supplied for global removal to report the effective skill in that Workspace afterward.",
            ),
        agents_digest:
          agentsDigestSchema,
      }),
      _meta: {
        securitySchemes: [
          { type: "noauth" },
        ],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      name,
      scope,
      workspace,
      agents_digest,
    }) => {
      try {
        const result =
          await skills.remove({
            name,
            scope,
            workspace,
            agentsDigest:
              agents_digest,
          });
        return success(result);
      } catch (error) {
        return skillToolError(
          error,
        );
      }
    },
  );
}
