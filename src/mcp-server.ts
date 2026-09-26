import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { RunCommandService, type RunCommandResult } from "./run-command.js";
import {
  JobManager,
  JobManagerError,
} from "./job-manager.js";
import {
  WorkspaceFileError,
  WorkspaceFilesService,
} from "./workspace-files.js";
import {
  PLAYWRIGHT_CLI_COMMANDS,
  PlaywrightCliError,
  PlaywrightCliService,
} from "./playwright-cli.js";

const stableIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const workspacePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .describe("Workspace-relative path. Absolute paths are not accepted.");

const runCommandInputSchema = z.object({
  workspace: stableIdSchema.describe(
    "Registered Junius Workspace ID. This is an ID managed by Junius, not a filesystem path.",
  ),
  key: stableIdSchema.describe("Registered Junius capability key."),
  args: z
    .array(z.string().max(4_096))
    .max(128)
    .default([])
    .describe("Argument vector passed to the registered capability adapter."),
});

export function formatRunCommandResult(
  result: RunCommandResult,
): string {
  if (!result.ok) {
    return JSON.stringify({
      ok: false,
      workspace: result.workspace,
      key: result.key,
      code: result.code,
      message: result.message,
      ...(result.execution === undefined
        ? {}
        : {
            execution: {
              exitCode: result.execution.exitCode,
              signal: result.execution.signal,
              stdout: result.execution.stdout,
              stderr: result.execution.stderr,
              durationMs: result.execution.durationMs,
            },
          }),
    });
  }

  return JSON.stringify({
    ok: true,
    workspace: result.workspace,
    key: result.key,
    execution: {
      exitCode: result.execution.exitCode,
      stdout: result.execution.stdout,
      stderr: result.execution.stderr,
      durationMs: result.execution.durationMs,
    },
  });
}

function playwrightCliToolError(error: unknown) {
  if (error instanceof PlaywrightCliError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            code: error.code,
            message: error.message,
          }),
        },
      ],
    };
  }

  throw error;
}

function jobToolError(error: unknown) {
  if (error instanceof JobManagerError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            code: error.code,
            message: error.message,
          }),
        },
      ],
    };
  }

  throw error;
}

function fileToolError(error: unknown) {
  if (error instanceof WorkspaceFileError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            code: error.code,
            message: error.message,
          }),
        },
      ],
    };
  }

  throw error;
}

export function createMcpServer(
  commands: RunCommandService,
  files: WorkspaceFilesService,
  jobs: JobManager,
  playwrightCli: PlaywrightCliService,
): McpServer {
  const server = new McpServer({
    name: "Junius",
    title: "Junius Local Agent",
    version: "0.8.0",
  });

  server.registerTool(
    "list_workspaces",
    {
      title: "List Junius Workspaces",
      description:
        "List registered Junius Workspaces, their roots, and the capability argument grants available in each Workspace. Use this before choosing a Workspace when the user refers to a project by name rather than by Workspace ID.",
      inputSchema: z.object({}),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            workspaces: commands.listWorkspaces(),
          }),
        },
      ],
    }),
  );

  server.registerTool(
    "ls",
    {
      title: "List Workspace Files",
      description:
        "List files and directories inside one registered Junius Workspace. Paths are Workspace-relative.",
      inputSchema: z.object({
        workspace: stableIdSchema,
        path: workspacePathSchema.default("."),
        depth: z.number().int().min(1).max(4).default(1),
      }),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace, path, depth }) => {
      try {
        const entries = await files.ls(workspace, path, depth);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                workspace,
                path,
                entries,
              }),
            },
          ],
        };
      } catch (error) {
        return fileToolError(error);
      }
    },
  );

  server.registerTool(
    "read",
    {
      title: "Read Workspace Files",
      description:
        "Read one or more UTF-8 text files from a registered Junius Workspace.",
      inputSchema: z.object({
        workspace: stableIdSchema,
        files: z
          .array(
            z.object({
              path: workspacePathSchema,
              start_line: z.number().int().min(1).optional(),
              end_line: z.number().int().min(1).optional(),
            }),
          )
          .min(1)
          .max(16),
      }),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace, files: requests }) => {
      try {
        const results = await files.read(
          workspace,
          requests.map((request) => ({
            path: request.path,
            ...(request.start_line === undefined
              ? {}
              : { startLine: request.start_line }),
            ...(request.end_line === undefined
              ? {}
              : { endLine: request.end_line }),
          })),
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                workspace,
                files: results,
              }),
            },
          ],
        };
      } catch (error) {
        return fileToolError(error);
      }
    },
  );

  server.registerTool(
    "write",
    {
      title: "Write Workspace Files",
      description:
        "Create, replace, or exact-text edit UTF-8 files inside a registered Junius Workspace. A prior read is not required. Exact-text edits fail if old_text is missing or ambiguous unless replace_all is explicitly enabled. All writes are validated before any file is changed.",
      inputSchema: z.object({
        workspace: stableIdSchema,
        files: z
          .array(
            z
              .object({
                path: workspacePathSchema,
                content: z.string().max(2 * 1024 * 1024).optional(),
                edits: z
                  .array(
                    z.object({
                      old_text: z.string().min(1),
                      new_text: z.string(),
                      replace_all: z.boolean().default(false),
                    }),
                  )
                  .min(1)
                  .max(128)
                  .optional(),
              })
              .superRefine((file, context) => {
                if ((file.content === undefined) === (file.edits === undefined)) {
                  context.addIssue({
                    code: "custom",
                    message:
                      "Exactly one of content or edits must be supplied.",
                  });
                }
              }),
          )
          .min(1)
          .max(16),
      }),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspace, files: requests }) => {
      try {
        const results = await files.write(
          workspace,
          requests.map((request) => ({
            path: request.path,
            ...(request.content === undefined
              ? {}
              : { content: request.content }),
            ...(request.edits === undefined
              ? {}
              : {
                  edits: request.edits.map((edit) => ({
                    oldText: edit.old_text,
                    newText: edit.new_text,
                    replaceAll: edit.replace_all,
                  })),
                }),
          })),
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                workspace,
                files: results,
              }),
            },
          ],
        };
      } catch (error) {
        return fileToolError(error);
      }
    },
  );

  server.registerTool(
    "rg",
    {
      title: "Search Workspace Text",
      description:
        "Search text inside one registered Junius Workspace using ripgrep. Paths are Workspace-relative and ripgrep configuration files are disabled.",
      inputSchema: z.object({
        workspace: stableIdSchema,
        query: z.string().min(1).max(4_096),
        path: workspacePathSchema.default("."),
        globs: z.array(z.string().min(1).max(1_024)).max(32).default([]),
        case_sensitive: z.boolean().default(true),
        fixed_strings: z.boolean().default(false),
        hidden: z.boolean().default(false),
        max_results: z.number().int().min(1).max(500).default(100),
      }),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      workspace,
      query,
      path,
      globs,
      case_sensitive,
      fixed_strings,
      hidden,
      max_results,
    }) => {
      try {
        const matches = await files.rg(workspace, {
          query,
          path,
          globs,
          caseSensitive: case_sensitive,
          fixedStrings: fixed_strings,
          hidden,
          maxResults: max_results,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                workspace,
                query,
                matches,
              }),
            },
          ],
        };
      } catch (error) {
        return fileToolError(error);
      }
    },
  );

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
    "start_job",
    {
      title: "Start Local Job",
      description:
        "Start a long-running registered process capability in one explicitly selected Junius Workspace. Authorization is identical to run_command, but the process continues in the background and is managed by a returned job ID.",
      inputSchema: runCommandInputSchema,
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspace, key, args }) => {
      try {
        const job = jobs.start(workspace, key, args);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                job,
              }),
            },
          ],
        };
      } catch (error) {
        return jobToolError(error);
      }
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get Local Job",
      description:
        "Get the current status and output-size metadata for one Junius job.",
      inputSchema: z.object({
        job: z.string().uuid(),
      }),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                job: jobs.get(job),
              }),
            },
          ],
        };
      } catch (error) {
        return jobToolError(error);
      }
    },
  );

  server.registerTool(
    "wait_job",
    {
      title: "Wait for Local Job",
      description:
        "Wait briefly for one Junius job to finish. Returns the current status when the job completes or when the wait timeout is reached.",
      inputSchema: z.object({
        job: z.string().uuid(),
        timeout_ms: z.number().int().min(0).max(60_000).default(30_000),
      }),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job, timeout_ms }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                job: await jobs.wait(job, timeout_ms),
              }),
            },
          ],
        };
      } catch (error) {
        return jobToolError(error);
      }
    },
  );

  server.registerTool(
    "read_job_output",
    {
      title: "Read Local Job Output",
      description:
        "Read captured stdout or stderr from one Junius job using a character offset cursor.",
      inputSchema: z.object({
        job: z.string().uuid(),
        stream: z.enum(["stdout", "stderr"]).default("stdout"),
        offset: z.number().int().min(0).default(0),
        limit: z
          .number()
          .int()
          .min(1)
          .max(256 * 1024)
          .default(64 * 1024),
      }),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job, stream, offset, limit }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                output: jobs.readOutput(
                  job,
                  stream,
                  offset,
                  limit,
                ),
              }),
            },
          ],
        };
      } catch (error) {
        return jobToolError(error);
      }
    },
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Cancel Local Job",
      description:
        "Cancel one running Junius job. On Windows Junius uses taskkill /T /F for best-effort process-tree termination.",
      inputSchema: z.object({
        job: z.string().uuid(),
      }),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                job: await jobs.cancel(job),
              }),
            },
          ],
        };
      } catch (error) {
        return jobToolError(error);
      }
    },
  );

  server.registerTool(
    "run_command",
    {
      title: "Run Junius Capability",
      description:
        "Run one registered Junius capability in one explicitly selected Junius Workspace. If the user names a project rather than a Workspace ID, use list_workspaces first. The Workspace ID and capability key must already be registered and authorized. Filesystem paths and shell command strings are not accepted as capability selectors.",
      inputSchema: runCommandInputSchema,
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspace, key, args }) => {
      const result = await commands.run(workspace, key, args);

      return {
        isError: !result.ok,
        content: [
          {
            type: "text" as const,
            text: formatRunCommandResult(result),
          },
        ],
      };
    },
  );

  return server;
}
