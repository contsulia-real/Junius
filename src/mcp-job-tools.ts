import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { JobManager } from "./job-manager.js";
import {
  DEFAULT_JOB_WAIT_MS,
  MAX_JOB_WAIT_MS,
} from "./job-query.js";
import {
  jobToolError,
  runCommandInputSchema,
} from "./mcp-tool-shared.js";

export function registerJobTools(
  server: McpServer,
  jobs: JobManager,
): void {
  server.registerTool(
    "start_job",
    {
      title: "Start Local Job",
      description:
        "Launch any executable with any argument vector as a background process in one registered Junius Workspace and return immediately. Use this for work that may outlive a short MCP request, including builds, tests, installs, and other commands that may run longer than the foreground command window. Poll with wait_job; pass stdout_offset/stderr_offset cursors when progress output is needed so status and new output share the same short Secure MCP Tunnel request.",
      inputSchema: runCommandInputSchema,
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
    async ({ workspace, executable, args }) => {
      try {
        const job = await jobs.start(
          workspace,
          executable,
          args,
        );
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
                job: await jobs.get(job),
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
        "Wait for one Junius job in a short bounded poll. The maximum wait is 10 seconds so long-running work does not hold one Secure MCP Tunnel request open. Pass stdout_offset and/or stderr_offset to receive only new captured output in the same call, then reuse nextOffset on the next poll.",
      inputSchema: z.object({
        job: z.string().uuid(),
        timeout_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_JOB_WAIT_MS)
          .default(DEFAULT_JOB_WAIT_MS),
        stdout_offset: z.number().int().min(0).optional(),
        stderr_offset: z.number().int().min(0).optional(),
        output_limit: z
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
    async ({
      job,
      timeout_ms,
      stdout_offset,
      stderr_offset,
      output_limit,
    }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                ...(await jobs.waitWithOutput(
                  job,
                  timeout_ms,
                  stdout_offset,
                  stderr_offset,
                  output_limit,
                )),
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
                output: await jobs.readOutput(
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

}
